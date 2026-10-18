package runtime

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/jphacks/sd_2601/internal/network"
	"github.com/jphacks/sd_2601/internal/security"
)

func TestPrepareDoesNotStartAndStartRechecksCompose(t *testing.T) {
	provider := &fakeProvider{}
	store := NewMemoryStore()
	manager, err := NewManager(store, provider)
	if err != nil {
		t.Fatal(err)
	}
	session, err := manager.Prepare(context.Background(), validLab())
	if err != nil {
		t.Fatal(err)
	}
	if provider.starts != 0 || session.State != Prepared || !session.SafetyChecked {
		t.Fatalf("prepare = %#v, starts=%d", session, provider.starts)
	}
	session.Compose = []byte("services:\n  app:\n    image: example/app@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n    privileged: true\n")
	if err := store.Save(context.Background(), session); err != nil {
		t.Fatal(err)
	}
	if _, err := manager.Start(context.Background(), session.ID); err == nil {
		t.Fatal("unsafe stored compose started")
	}
	if provider.starts != 0 {
		t.Fatal("provider started unsafe compose")
	}
}

func TestLifecycleRollsBackAndDeleteIsIdempotent(t *testing.T) {
	provider := &fakeProvider{resources: Resources{Containers: []Container{{Name: "app", State: "running"}}}}
	manager, _ := NewManager(NewMemoryStore(), provider)
	session, err := manager.Prepare(context.Background(), validLab())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := manager.Start(context.Background(), session.ID); err != nil {
		t.Fatal(err)
	}
	provider.resources = Resources{Volumes: []string{"reprokit_data"}}
	stopped, err := manager.Stop(context.Background(), session.ID)
	if err != nil || stopped.State != Stopped {
		t.Fatalf("stop = %#v, %v", stopped, err)
	}
	deleted, err := manager.Delete(context.Background(), session.ID, false)
	if err != nil || deleted.State != Deleted || len(deleted.RetainedVolumes) != 1 {
		t.Fatalf("delete = %#v, %v", deleted, err)
	}
	if _, err := manager.Delete(context.Background(), session.ID, false); err != nil {
		t.Fatal(err)
	}
	if provider.deletes != 1 {
		t.Fatalf("delete calls = %d", provider.deletes)
	}
}

func TestStartFailureCleansUp(t *testing.T) {
	provider := &fakeProvider{startErr: errors.New("daemon unavailable")}
	manager, _ := NewManager(NewMemoryStore(), provider)
	session, err := manager.Prepare(context.Background(), validLab())
	if err != nil {
		t.Fatal(err)
	}
	result, err := manager.Start(context.Background(), session.ID)
	if err == nil || !strings.Contains(err.Error(), "daemon unavailable") || result.State != Failed || provider.deletes != 1 {
		t.Fatalf("start = %#v, %v, deletes=%d", result, err, provider.deletes)
	}
}

func TestStartFailsClosedWhenDiskUsageCannotBeMeasured(t *testing.T) {
	provider := &fakeProvider{diskUsageErr: errors.New("Docker unavailable")}
	manager, err := NewManager(NewMemoryStore(), provider)
	if err != nil {
		t.Fatal(err)
	}
	session, err := manager.Prepare(context.Background(), validLab())
	if err != nil {
		t.Fatal(err)
	}
	result, err := manager.Start(context.Background(), session.ID)
	if err == nil || result.State != Failed || provider.starts != 1 || provider.deletes != 1 {
		t.Fatalf("Start = %#v, %v, starts=%d, deletes=%d", result, err, provider.starts, provider.deletes)
	}
}

func TestExpirationStopsTheLabAndReportsTheReason(t *testing.T) {
	provider := &fakeProvider{stopSignal: make(chan struct{})}
	store := NewMemoryStore()
	manager, err := NewManager(store, provider)
	if err != nil {
		t.Fatal(err)
	}
	session, err := manager.Prepare(context.Background(), validLab())
	if err != nil {
		t.Fatal(err)
	}
	session, err = manager.Start(context.Background(), session.ID)
	if err != nil || session.ExpiresAt == nil {
		t.Fatalf("Start = %#v, %v", session, err)
	}
	expired := time.Now().UTC().Add(-time.Second)
	session.ExpiresAt = &expired
	if err := store.Save(context.Background(), session); err != nil {
		t.Fatal(err)
	}
	manager.scheduleExpiration(session)
	select {
	case <-provider.stopSignal:
	case <-time.After(time.Second):
		t.Fatal("expiration did not stop the Lab")
	}
	stopped, err := manager.Status(context.Background(), session.ID)
	if err != nil || stopped.State != Stopped || stopped.StopReason != "expired" {
		t.Fatalf("Status = %#v, %v", stopped, err)
	}
}

func TestRecoverCleansUpRunningLabAfterRunnerRestart(t *testing.T) {
	provider := &fakeProvider{resources: Resources{Networks: []string{"reprokit_old"}}}
	store := NewMemoryStore()
	manager, err := NewManager(store, provider)
	if err != nil {
		t.Fatal(err)
	}
	session, err := manager.Prepare(context.Background(), validLab())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := manager.Start(context.Background(), session.ID); err != nil {
		t.Fatal(err)
	}
	provider.resources = Resources{Volumes: []string{"reprokit_retained"}}
	if err := manager.Recover(context.Background()); err != nil {
		t.Fatal(err)
	}
	recovered, err := manager.Status(context.Background(), session.ID)
	if err != nil || recovered.State != Stopped || recovered.StopReason != "runner_restarted" || len(recovered.RetainedVolumes) != 1 || provider.deletes != 1 {
		t.Fatalf("Recover = %#v, %v, deletes=%d", recovered, err, provider.deletes)
	}
}

func TestDiskLimitStopsRunningLab(t *testing.T) {
	provider := &fakeProvider{resources: Resources{Containers: []Container{{Name: "app", State: "running"}}}}
	manager, err := NewManager(NewMemoryStore(), provider)
	if err != nil {
		t.Fatal(err)
	}
	manager.diskCheckInterval = time.Hour
	session, err := manager.Prepare(context.Background(), validLab())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := manager.Start(context.Background(), session.ID); err != nil {
		t.Fatal(err)
	}
	provider.diskUsage = int64(session.Guardrails.DiskMiB)*1024*1024 + 1
	manager.enforceDiskLimit(session.ID)
	stopped, err := manager.Status(context.Background(), session.ID)
	if err != nil || stopped.State != Stopped || stopped.StopReason != "disk_limit_exceeded" || provider.stops != 1 {
		t.Fatalf("disk limit result = %#v, %v, stops=%d", stopped, err, provider.stops)
	}
}

func TestDiskMonitorFailureStopsRunningLab(t *testing.T) {
	provider := &fakeProvider{resources: Resources{Containers: []Container{{Name: "app", State: "running"}}}}
	manager, err := NewManager(NewMemoryStore(), provider)
	if err != nil {
		t.Fatal(err)
	}
	manager.diskCheckInterval = time.Hour
	session, err := manager.Prepare(context.Background(), validLab())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := manager.Start(context.Background(), session.ID); err != nil {
		t.Fatal(err)
	}
	provider.diskUsageErr = errors.New("Docker unavailable")
	manager.enforceDiskLimit(session.ID)
	stopped, err := manager.Status(context.Background(), session.ID)
	if err != nil || stopped.State != Stopped || stopped.StopReason != "disk_monitor_unavailable" || provider.stops != 1 {
		t.Fatalf("disk monitor result = %#v, %v, stops=%d", stopped, err, provider.stops)
	}
}

func TestStartRejectsTamperedLockArtifact(t *testing.T) {
	provider := &fakeProvider{}
	store := NewMemoryStore()
	manager, _ := NewManager(store, provider)
	session, err := manager.Prepare(context.Background(), validLab())
	if err != nil {
		t.Fatal(err)
	}
	session.Manifest = append(session.Manifest, []byte("# changed\n")...)
	if err := store.Save(context.Background(), session); err != nil {
		t.Fatal(err)
	}
	if _, err := manager.Start(context.Background(), session.ID); err == nil {
		t.Fatal("tampered Manifest started")
	}
	if provider.starts != 0 {
		t.Fatal("provider started a tampered Lab artifact")
	}
}

func TestPrepareWritesCompleteLockfile(t *testing.T) {
	manager, _ := NewManager(NewMemoryStore(), &fakeProvider{})
	session, err := manager.Prepare(context.Background(), validLab())
	if err != nil {
		t.Fatal(err)
	}
	lock, err := decodeLock(session.Lockfile)
	if err != nil {
		t.Fatal(err)
	}
	if lock.LockVersion != 1 || lock.Lab != session.LabID || lock.Source.URL != "https://github.com/Saku0512/vulhub.git" || lock.Source.Subdirectory != "filebrowser/CVE-2026-54088" || lock.Runtime.Platform != "linux/amd64" || lock.Images["app"].Platform != "linux/amd64" {
		t.Fatalf("lock = %#v", lock)
	}
}

func TestOfflineArtifactsListsOnlyFixedSourceAndImages(t *testing.T) {
	store := NewMemoryStore()
	manager, _ := NewManager(store, &fakeProvider{})
	session, err := manager.Prepare(context.Background(), validLab())
	if err != nil {
		t.Fatal(err)
	}
	artifacts, err := manager.OfflineArtifacts(context.Background(), session.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(artifacts) != 3 || artifacts[0].Kind != "git-source" || artifacts[0].Revision != session.SourceRevision || artifacts[1].Kind != "container-image" || artifacts[1].Digest == "" || artifacts[2].Reference != "caddy" || artifacts[2].Digest == "" {
		t.Fatalf("unexpected offline artifacts: %#v", artifacts)
	}
	for _, artifact := range artifacts {
		if strings.Contains(strings.ToLower(artifact.Reference), "password") || strings.Contains(strings.ToLower(artifact.Reference), "token") {
			t.Fatalf("credential leaked into offline artifacts: %#v", artifact)
		}
	}
}

func TestPreparePublishesRunnerProxyAsTheOriginalService(t *testing.T) {
	manager, err := NewManager(NewMemoryStore(), &fakeProvider{})
	if err != nil {
		t.Fatal(err)
	}
	session, err := manager.Prepare(context.Background(), validLab())
	if err != nil {
		t.Fatal(err)
	}
	if len(session.Endpoints) != 1 || session.Endpoints[0] != (Endpoint{Service: "app", Address: "127.0.0.1", Port: 8080}) {
		t.Fatalf("endpoints = %#v", session.Endpoints)
	}
	if !strings.Contains(string(session.Compose), "reprokit_proxy_app_1") || !strings.Contains(string(session.Lockfile), "caddy") {
		t.Fatalf("Runner ingress proxy was not fixed in the stored artifacts")
	}
}

func TestConnectionCredentialsAreNotWrittenToLockfile(t *testing.T) {
	provider, err := NewDockerComposeProviderWithNetwork(network.Config{RegistryCredentials: []network.RegistryCredential{{Registry: "registry.example", Username: "learner", Password: "secret"}}})
	if err != nil {
		t.Fatal(err)
	}
	manager, err := NewManager(NewMemoryStore(), provider)
	if err != nil {
		t.Fatal(err)
	}
	session, err := manager.Prepare(context.Background(), validLab())
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(session.Lockfile), "secret") || strings.Contains(string(session.Lockfile), "learner") || strings.Contains(string(session.Lockfile), "registry.example") {
		t.Fatalf("connection credential leaked into lockfile: %s", session.Lockfile)
	}
}

func validLab() PreparedLab {
	return PreparedLab{
		LabID:          "vulhub/filebrowser-cve-2026-54088",
		SourceRevision: strings.Repeat("a", 40),
		Artifact: Artifact{
			RegistryRevision:   strings.Repeat("b", 40),
			ManifestPath:       "manifests/vulhub/filebrowser-cve-2026-54088.yaml",
			Manifest:           []byte("apiVersion: reprokit.dev/v1alpha1\nkind: Lab\n"),
			SourceURL:          "https://github.com/Saku0512/vulhub.git",
			SourceSubdirectory: "filebrowser/CVE-2026-54088",
			RuntimeFile:        "reprokit.compose.yml",
			Platform:           "linux/amd64",
		},
		Compose:    []byte("services:\n  app:\n    image: example/app@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n    ports:\n      - \"8080:80\"\n"),
		Guardrails: security.Guardrails{MaxRuntimeSeconds: 1800, CPUCores: 1, MemoryMiB: 512, PIDs: 128, DiskMiB: 1024, Egress: "none"},
	}
}

func TestPrepareAllowsReviewedGoGitLab(t *testing.T) {
	manager, err := NewManager(NewMemoryStore(), &fakeProvider{})
	if err != nil {
		t.Fatal(err)
	}
	lab := validLab()
	lab.LabID = "reprokit/go-git-cve-2026-71557"
	lab.Artifact.ManifestPath = "manifests/reprokit/go-git-cve-2026-71557.yaml"
	lab.Artifact.SourceURL = "https://github.com/Saku0512/reprokit-go-git-cve-2026-71557-lab.git"
	lab.Artifact.SourceSubdirectory = "lab"
	lab.Artifact.RuntimeFile = "compose.yaml"

	session, err := manager.Prepare(context.Background(), lab)
	if err != nil {
		t.Fatal(err)
	}
	if session.LabID != lab.LabID {
		t.Fatalf("lab ID = %q, want %q", session.LabID, lab.LabID)
	}
}

func TestObserveMarkerReadsOnlyRunningComparisonService(t *testing.T) {
	provider := &fakeProvider{marker: "uid=1000(filebrowser)"}
	manager, err := NewManager(NewMemoryStore(), provider)
	if err != nil {
		t.Fatal(err)
	}
	lab := validLab()
	lab.Compose = []byte("services:\n  vulnerable:\n    image: example/vulnerable@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n    ports:\n      - \"18080:80\"\n  fixed:\n    image: example/fixed@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n    ports:\n      - \"18081:80\"\n")
	session, err := manager.Prepare(context.Background(), lab)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := manager.ObserveMarker(context.Background(), session.ID, "vulnerable"); !errors.Is(err, ErrInvalidState) {
		t.Fatalf("prepared observation error = %v", err)
	}
	if _, err := manager.Start(context.Background(), session.ID); err != nil {
		t.Fatal(err)
	}
	observation, err := manager.ObserveMarker(context.Background(), session.ID, "vulnerable")
	if err != nil {
		t.Fatal(err)
	}
	if !observation.Exists || observation.Content != provider.marker || observation.Service != "vulnerable" || provider.markerReads != 1 {
		t.Fatalf("observation = %#v, reads = %d", observation, provider.markerReads)
	}
	if _, err := manager.ObserveMarker(context.Background(), session.ID, "other"); err == nil {
		t.Fatal("unknown comparison service was accepted")
	}
}

func TestReadLogsReadsOnlyRunningComparisonService(t *testing.T) {
	provider := &fakeProvider{logs: LogSnapshot{Service: "vulnerable", Content: "login failed\n"}}
	manager, err := NewManager(NewMemoryStore(), provider)
	if err != nil {
		t.Fatal(err)
	}
	lab := validLab()
	lab.Compose = []byte("services:\n  vulnerable:\n    image: example/vulnerable@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n    ports:\n      - \"18080:80\"\n  fixed:\n    image: example/fixed@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n    ports:\n      - \"18081:80\"\n")
	session, err := manager.Prepare(context.Background(), lab)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := manager.ReadLogs(context.Background(), session.ID, "vulnerable"); !errors.Is(err, ErrInvalidState) {
		t.Fatalf("prepared log error = %v", err)
	}
	if _, err := manager.Start(context.Background(), session.ID); err != nil {
		t.Fatal(err)
	}
	logs, err := manager.ReadLogs(context.Background(), session.ID, "vulnerable")
	if err != nil {
		t.Fatal(err)
	}
	if logs != provider.logs || provider.logReads != 1 {
		t.Fatalf("logs = %#v, reads = %d", logs, provider.logReads)
	}
	if _, err := manager.ReadLogs(context.Background(), session.ID, "reprokit_proxy_vulnerable_1"); err == nil {
		t.Fatal("internal proxy service was accepted")
	}
}

func TestRunActionExecutesOnlyFixedActionInRunningComparisonService(t *testing.T) {
	provider := &fakeProvider{action: ActionObservation{Service: "vulnerable", Action: ListTmpAction, Output: "success\n"}}
	manager, err := NewManager(NewMemoryStore(), provider)
	if err != nil {
		t.Fatal(err)
	}
	lab := validLab()
	lab.Compose = []byte("services:\n  vulnerable:\n    image: example/vulnerable@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n    ports:\n      - \"18080:80\"\n  fixed:\n    image: example/fixed@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n    ports:\n      - \"18081:80\"\n")
	session, err := manager.Prepare(context.Background(), lab)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := manager.RunAction(context.Background(), session.ID, "vulnerable", ListTmpAction); !errors.Is(err, ErrInvalidState) {
		t.Fatalf("prepared action error = %v", err)
	}
	if _, err := manager.Start(context.Background(), session.ID); err != nil {
		t.Fatal(err)
	}
	result, err := manager.RunAction(context.Background(), session.ID, "vulnerable", ListTmpAction)
	if err != nil || result != provider.action || provider.actionRuns != 1 {
		t.Fatalf("result=%#v err=%v runs=%d", result, err, provider.actionRuns)
	}
	if _, err := manager.RunAction(context.Background(), session.ID, "vulnerable", "shell"); err == nil {
		t.Fatal("unknown action was accepted")
	}
	if _, err := manager.RunAction(context.Background(), session.ID, "reprokit_proxy_vulnerable_1", ListTmpAction); err == nil {
		t.Fatal("internal proxy service was accepted")
	}
}

type fakeProvider struct {
	starts, stops, deletes int
	startErr               error
	resources              Resources
	diskUsage              int64
	diskUsageErr           error
	marker                 string
	markerReads            int
	logs                   LogSnapshot
	logReads               int
	action                 ActionObservation
	actionRuns             int
	stopSignal             chan struct{}
}

func (provider *fakeProvider) Start(context.Context, string, []byte) error {
	provider.starts++
	return provider.startErr
}
func (provider *fakeProvider) Stop(context.Context, string, []byte) error {
	provider.stops++
	if provider.stopSignal != nil {
		select {
		case <-provider.stopSignal:
		default:
			close(provider.stopSignal)
		}
	}
	return nil
}
func (provider *fakeProvider) Delete(context.Context, string, []byte, bool) error {
	provider.deletes++
	return nil
}
func (provider *fakeProvider) Inspect(context.Context, string, []byte) (Resources, error) {
	return provider.resources, nil
}
func (provider *fakeProvider) DiskUsage(context.Context, string) (int64, error) {
	return provider.diskUsage, provider.diskUsageErr
}
func (provider *fakeProvider) ReadMarker(context.Context, string, []byte, string) (string, error) {
	provider.markerReads++
	return provider.marker, nil
}
func (provider *fakeProvider) ReadLogs(context.Context, string, []byte, string) (LogSnapshot, error) {
	provider.logReads++
	return provider.logs, nil
}
func (provider *fakeProvider) RunAction(context.Context, string, []byte, string, ObservationAction) (ActionObservation, error) {
	provider.actionRuns++
	return provider.action, nil
}
