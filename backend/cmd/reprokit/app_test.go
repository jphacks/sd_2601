package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/jphacks/sd_2601/internal/lab"
	"github.com/jphacks/sd_2601/internal/runtime"
)

type harmlessProvider struct{ starts, stops, deletes, inspections atomic.Int32 }

func (provider *harmlessProvider) Start(context.Context, string, []byte) error {
	provider.starts.Add(1)
	return nil
}
func (provider *harmlessProvider) Stop(context.Context, string, []byte) error {
	provider.stops.Add(1)
	return nil
}
func (provider *harmlessProvider) Delete(context.Context, string, []byte, bool) error {
	provider.deletes.Add(1)
	return nil
}
func (provider *harmlessProvider) Inspect(context.Context, string, []byte) (runtime.Resources, error) {
	provider.inspections.Add(1)
	return runtime.Resources{}, nil
}
func (provider *harmlessProvider) DiskUsage(context.Context, string) (int64, error) { return 0, nil }

// 実ファイルのGitオブジェクトだけを共有し、一時リポジトリ内の変更で元worktreeへ触れない。
func repositoryFixture(t *testing.T) string {
	t.Helper()
	original, err := filepath.Abs("../../..")
	if err != nil {
		t.Fatal(err)
	}
	root := filepath.Join(t.TempDir(), "repository")
	command := exec.Command("git", "clone", "--quiet", "--no-checkout", "--shared", original, root)
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("repository fixture: %v: %s", err, output)
	}
	return root
}

func harmlessSource(_ context.Context, resolved lab.ResolvedLab, _ string) (lab.MaterializedSource, error) {
	compose := []byte("services:\n  vulnerable:\n    image: example/harmless@sha256:" + strings.Repeat("a", 64) + "\n    ports:\n      - \"127.0.0.1:18080:80\"\n  fixed:\n    image: example/harmless@sha256:" + strings.Repeat("b", 64) + "\n    ports:\n      - \"127.0.0.1:18081:80\"\n")
	digest := sha256.Sum256(compose)
	hash := hex.EncodeToString(digest[:])
	return lab.MaterializedSource{URL: resolved.Source.URL, Revision: resolved.Source.Revision, Subdirectory: resolved.Source.Subdirectory, ComposeSHA256: hash, RuntimeCompose: compose, Files: []lab.SourceFile{{Path: resolved.Runtime.File, SHA256: hash}}}, nil
}

func serveApplication(t *testing.T, app *application) string {
	t.Helper()
	server := &http.Server{Handler: app.server.Handler}
	go func() { _ = server.Serve(app.server.Listener) }()
	t.Cleanup(func() { _ = server.Close(); app.Close() })
	return "http://" + app.server.Listener.Addr().String()
}

func requestJSON(t *testing.T, origin, token, method, path string, body any, expected int, target any) {
	t.Helper()
	var input io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		input = bytes.NewReader(data)
	}
	request, err := http.NewRequest(method, origin+path, input)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Origin", origin)
	request.Header.Set("X-Reprokit-Session", token)
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != expected {
		data, _ := io.ReadAll(response.Body)
		t.Fatalf("%s %s = %d: %s", method, path, response.StatusCode, data)
	}
	if target != nil {
		if err := json.NewDecoder(response.Body).Decode(target); err != nil {
			t.Fatal(err)
		}
	}
}

func TestRealCoreWiringDefersPreparationAndRestoresAfterRestart(t *testing.T) {
	ctx := context.Background()
	config := configuration{repository: repositoryFixture(t), state: filepath.Join(t.TempDir(), "state")}
	provider := &harmlessProvider{}
	var fetches atomic.Int32
	loader := func(ctx context.Context, resolved lab.ResolvedLab, destination string) (lab.MaterializedSource, error) {
		fetches.Add(1)
		return harmlessSource(ctx, resolved, destination)
	}
	app, err := newApplication(ctx, config, provider, loader)
	if err != nil {
		t.Fatal(err)
	}
	origin := serveApplication(t, app)
	token := app.server.SessionToken
	requestJSON(t, origin, "", http.MethodGet, "/api/lessons", nil, 401, nil)
	var catalog []map[string]any
	requestJSON(t, origin, token, http.MethodGet, "/api/lessons", nil, 200, &catalog)
	if len(catalog) != 2 || fetches.Load() != 0 || provider.inspections.Load() != 0 {
		t.Fatal("startup or lesson read touched Lab execution")
	}
	lessonIDs := map[string]bool{}
	for _, item := range catalog {
		id, _ := item["id"].(string)
		lessonIDs[id] = true
	}
	if !lessonIDs[lessonID] || !lessonIDs[goGitLessonID] {
		t.Fatalf("catalog = %#v, want both reviewed Lessons", catalog)
	}
	requestJSON(t, origin, token, http.MethodPost, "/api/labs", map[string]any{"lessonId": lessonID, "lessonVersion": lessonVersion, "labRef": "vulnerable", "command": "id"}, 400, nil)
	if fetches.Load() != 0 {
		t.Fatal("invalid request fetched source")
	}
	var session runtime.Session
	requestJSON(t, origin, token, http.MethodPost, "/api/labs", map[string]any{"lessonId": lessonID, "lessonVersion": lessonVersion, "labRef": "vulnerable"}, 200, &session)
	if fetches.Load() != 1 || provider.starts.Load() != 0 || provider.inspections.Load() != 0 || session.State != runtime.Prepared || len(session.Endpoints) != 2 {
		t.Fatal("Prepare did not preserve the real Core safety boundary")
	}
	requestJSON(t, origin, token, http.MethodPost, "/api/labs/"+session.ID+"/start", map[string]bool{"confirmed": false}, 400, nil)
	if provider.starts.Load() != 0 {
		t.Fatal("unconfirmed start executed")
	}
	app.Close()
	restarted, err := newApplication(ctx, config, provider, loader)
	if err != nil {
		t.Fatal(err)
	}
	newOrigin := serveApplication(t, restarted)
	newToken := restarted.server.SessionToken
	if newToken == token {
		t.Fatal("Runner token was reused across processes")
	}
	requestJSON(t, newOrigin, token, http.MethodGet, "/api/lessons", nil, 401, nil)
	requestJSON(t, newOrigin, newToken, http.MethodPost, "/api/labs/"+session.ID+"/start", map[string]bool{"confirmed": true}, 200, &session)
	if session.State != runtime.Running || provider.starts.Load() != 1 || fetches.Load() != 1 {
		t.Fatal("restart lost the stored artifact or fetched source during Start")
	}
	requestJSON(t, newOrigin, newToken, http.MethodPost, "/api/labs/"+session.ID+"/stop", nil, 200, &session)
	if session.State != runtime.Stopped || provider.stops.Load() != 1 {
		t.Fatal("Stop did not reach the provider")
	}
	requestJSON(t, newOrigin, newToken, http.MethodDelete, "/api/labs/"+session.ID+"?volumePolicy=retain", nil, 200, &session)
	if session.State != runtime.Deleted || provider.deletes.Load() != 1 {
		t.Fatal("Delete did not reach the provider")
	}
}

func TestGoGitLessonPreparesOnlyItsReviewedReference(t *testing.T) {
	ctx := context.Background()
	provider := &harmlessProvider{}
	var fetches atomic.Int32
	loader := func(ctx context.Context, resolved lab.ResolvedLab, destination string) (lab.MaterializedSource, error) {
		fetches.Add(1)
		return harmlessSource(ctx, resolved, destination)
	}
	app, err := newApplication(ctx, configuration{repository: repositoryFixture(t), state: filepath.Join(t.TempDir(), "state")}, provider, loader)
	if err != nil {
		t.Fatal(err)
	}
	origin := serveApplication(t, app)
	requestJSON(t, origin, app.server.SessionToken, http.MethodPost, "/api/labs", map[string]any{"lessonId": goGitLessonID, "lessonVersion": goGitLessonVersion, "labRef": "fixed"}, 400, nil)
	if fetches.Load() != 0 {
		t.Fatal("unapproved comparison reference fetched source")
	}
	var session runtime.Session
	requestJSON(t, origin, app.server.SessionToken, http.MethodPost, "/api/labs", map[string]any{"lessonId": goGitLessonID, "lessonVersion": goGitLessonVersion, "labRef": "vulnerable"}, 200, &session)
	if session.LabID != goGitLabID || session.State != runtime.Prepared || fetches.Load() != 1 {
		t.Fatalf("Prepare() = %#v, fetches = %d", session, fetches.Load())
	}
}

func TestSnapshotUsesCommittedArtifactsAndRejectsUnsafeStateDirectory(t *testing.T) {
	root := repositoryFixture(t)
	if err := os.MkdirAll(filepath.Join(root, "registry"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "registry", "index.json"), []byte("unreviewed working tree"), 0o600); err != nil {
		t.Fatal(err)
	}
	app, err := newApplication(context.Background(), configuration{repository: root, state: filepath.Join(t.TempDir(), "state")}, &harmlessProvider{}, harmlessSource)
	if err != nil {
		t.Fatal(err)
	}
	app.Close()
	public := filepath.Join(t.TempDir(), "public")
	if err := os.Mkdir(public, 0o755); err != nil {
		t.Fatal(err)
	}
	if _, err := newApplication(context.Background(), configuration{repository: root, state: public}, &harmlessProvider{}, harmlessSource); err == nil {
		t.Fatal("public state directory was accepted")
	}
}

func TestPrepareRejectsTamperedAndUnsafeSourceWithoutStarting(t *testing.T) {
	for _, mode := range []string{"hash", "unsafe"} {
		t.Run(mode, func(t *testing.T) {
			provider := &harmlessProvider{}
			loader := func(ctx context.Context, resolved lab.ResolvedLab, destination string) (lab.MaterializedSource, error) {
				value, err := harmlessSource(ctx, resolved, destination)
				if mode == "hash" {
					value.ComposeSHA256 = strings.Repeat("0", 64)
				} else {
					value.RuntimeCompose = bytes.Replace(value.RuntimeCompose, []byte("    ports:"), []byte("    privileged: true\n    ports:"), 1)
					digest := sha256.Sum256(value.RuntimeCompose)
					value.ComposeSHA256 = hex.EncodeToString(digest[:])
					value.Files[0].SHA256 = value.ComposeSHA256
				}
				return value, err
			}
			app, err := newApplication(context.Background(), configuration{repository: repositoryFixture(t), state: filepath.Join(t.TempDir(), "state")}, provider, loader)
			if err != nil {
				t.Fatal(err)
			}
			origin := serveApplication(t, app)
			requestJSON(t, origin, app.server.SessionToken, http.MethodPost, "/api/labs", map[string]any{"lessonId": lessonID, "lessonVersion": lessonVersion, "labRef": "vulnerable"}, 500, nil)
			if provider.starts.Load() != 0 {
				t.Fatal("unsafe source started")
			}
		})
	}
}
