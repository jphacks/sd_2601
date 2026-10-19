package lab

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"strings"
	"testing"

	"github.com/jphacks/sd_2601/internal/runtime"
	"github.com/jphacks/sd_2601/internal/security"
)

func TestToPreparedLabBuildsFixedFileBrowserArtifact(t *testing.T) {
	manifest := []byte("apiVersion: reprokit.dev/v1alpha1\nkind: Lab\n")
	manifestDigest := sha256.Sum256(manifest)
	compose := []byte(`services:
  vulnerable:
    image: ghcr.io/saku0512/reprokit-filebrowser@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
    ports:
      - "127.0.0.1:8080:80"
`)
	composeDigest := sha256.Sum256(compose)
	resolved := ResolvedLab{
		ID:     "vulhub/filebrowser-cve-2026-54088",
		Source: Source{URL: "https://github.com/Saku0512/vulhub.git", Revision: strings.Repeat("a", 40), Subdirectory: "filebrowser/CVE-2026-54088"},
		Runtime: Runtime{File: "docker-compose.yml", Platform: "linux/amd64", Guardrails: security.Guardrails{
			MaxRuntimeSeconds: 1800, CPUCores: 1, MemoryMiB: 512, PIDs: 128, DiskMiB: 1024, Egress: "none",
		}},
		Registry: RegistryReference{Revision: strings.Repeat("b", 40), ManifestPath: "manifests/vulhub/filebrowser-cve-2026-54088.yaml"},
		Manifest: ManifestReference{SHA256: hex.EncodeToString(manifestDigest[:]), Bytes: manifest},
	}
	materialized := MaterializedSource{URL: resolved.Source.URL, Revision: resolved.Source.Revision, Subdirectory: resolved.Source.Subdirectory, ComposeSHA256: hex.EncodeToString(composeDigest[:]), RuntimeCompose: compose, Files: []SourceFile{{Path: "docker-compose.yml", SHA256: hex.EncodeToString(composeDigest[:])}}}
	prepared, err := ToPreparedLab(resolved, materialized)
	if err != nil || prepared.LabID != resolved.ID || string(prepared.Compose) != string(compose) || string(prepared.Artifact.Manifest) != string(manifest) {
		t.Fatalf("ToPreparedLab = %#v, %v", prepared, err)
	}
	manager, err := runtime.NewManager(runtime.NewMemoryStore(), artifactProvider{})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := manager.Prepare(context.Background(), prepared); err != nil {
		t.Fatalf("Prepare() error = %v", err)
	}
}

type artifactProvider struct{}

func (artifactProvider) Start(context.Context, string, []byte) error { return nil }
func (artifactProvider) Stop(context.Context, string, []byte) error  { return nil }
func (artifactProvider) Delete(context.Context, string, []byte, bool) error {
	return nil
}
func (artifactProvider) Inspect(context.Context, string, []byte) (runtime.Resources, error) {
	return runtime.Resources{}, nil
}
func (artifactProvider) DiskUsage(context.Context, string) (int64, error) { return 0, nil }

func TestToPreparedLabRejectsTamperedMaterializedCompose(t *testing.T) {
	resolved := ResolvedLab{ID: "vulhub/filebrowser-cve-2026-54088", Source: Source{URL: "https://github.com/Saku0512/vulhub.git", Revision: strings.Repeat("a", 40), Subdirectory: "filebrowser/CVE-2026-54088"}}
	if _, err := ToPreparedLab(resolved, MaterializedSource{URL: resolved.Source.URL, Revision: resolved.Source.Revision, Subdirectory: resolved.Source.Subdirectory, RuntimeCompose: []byte("changed")}); err == nil {
		t.Fatal("tampered materialized source was accepted")
	}
}

func TestToPreparedLabAllowsReviewedGoGitLab(t *testing.T) {
	manifest := []byte("apiVersion: reprokit.dev/v1alpha1\nkind: Lab\n")
	manifestDigest := sha256.Sum256(manifest)
	compose := []byte("services:\n  vulnerable:\n    image: example/app@sha256:" + strings.Repeat("a", 64) + "\n")
	composeDigest := sha256.Sum256(compose)
	resolved := ResolvedLab{
		ID:       "reprokit/go-git-cve-2026-71557",
		Source:   Source{URL: "https://github.com/Saku0512/reprokit-go-git-cve-2026-71557-lab.git", Revision: strings.Repeat("a", 40), Subdirectory: "lab"},
		Runtime:  Runtime{File: "compose.yaml", Platform: "linux/amd64", Guardrails: security.Guardrails{MaxRuntimeSeconds: 1800, CPUCores: 1, MemoryMiB: 512, PIDs: 128, DiskMiB: 1024, Egress: "none"}},
		Registry: RegistryReference{Revision: strings.Repeat("b", 40), ManifestPath: "manifests/reprokit/go-git-cve-2026-71557.yaml"},
		Manifest: ManifestReference{SHA256: hex.EncodeToString(manifestDigest[:]), Bytes: manifest},
	}
	materialized := MaterializedSource{URL: resolved.Source.URL, Revision: resolved.Source.Revision, Subdirectory: resolved.Source.Subdirectory, ComposeSHA256: hex.EncodeToString(composeDigest[:]), RuntimeCompose: compose, Files: []SourceFile{{Path: "compose.yaml", SHA256: hex.EncodeToString(composeDigest[:])}}}
	if _, err := ToPreparedLab(resolved, materialized); err != nil {
		t.Fatalf("ToPreparedLab() with reviewed go-git Lab error = %v", err)
	}
}
