package runnerapi

import (
	"context"
	"strings"
	"testing"

	"github.com/jphacks/sd_2601/internal/runtime"
	"github.com/jphacks/sd_2601/internal/security"
)

func TestLifecycleServicePreparesOnlyConfiguredLessonReference(t *testing.T) {
	manager, err := runtime.NewManager(runtime.NewMemoryStore(), runnerProvider{})
	if err != nil {
		t.Fatal(err)
	}
	fixed := FixedLab{
		Lesson: LessonReference{LessonID: "filebrowser/hook", LessonVersion: "1.0.0", LabRef: "vulnerable-and-fixed"},
		Prepared: runtime.PreparedLab{
			LabID:          "vulhub/filebrowser-cve-2026-54088",
			SourceRevision: strings.Repeat("a", 40),
			Artifact: runtime.Artifact{
				RegistryRevision:   strings.Repeat("b", 40),
				ManifestPath:       "manifests/vulhub/filebrowser-cve-2026-54088.yaml",
				Manifest:           []byte("apiVersion: reprokit.dev/v1alpha1\nkind: Lab\n"),
				SourceURL:          "https://github.com/Saku0512/vulhub.git",
				SourceSubdirectory: "filebrowser/CVE-2026-54088",
				RuntimeFile:        "reprokit.compose.yml",
				Platform:           "linux/amd64",
			},
			Compose: []byte(`services:
  app:
    image: example/app@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
    ports:
      - "8080:80"
`),
			Guardrails: security.Guardrails{MaxRuntimeSeconds: 1800, CPUCores: 1, MemoryMiB: 512, PIDs: 128, DiskMiB: 1024, Egress: "none"},
		},
	}
	service, err := NewLifecycleService(manager, fixed)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.Prepare(context.Background(), LessonReference{LessonID: "other", LessonVersion: "1.0.0", LabRef: "vulnerable-and-fixed"}); err == nil {
		t.Fatal("unconfigured Lesson reference was accepted")
	}
	session, err := service.Prepare(context.Background(), fixed.Lesson)
	if err != nil || session.LabID != fixed.Prepared.LabID || session.State != runtime.Prepared {
		t.Fatalf("Prepare = %#v, %v", session, err)
	}

	fixed.Prepared.LabID = "reprokit/go-git-cve-2026-71557"
	if _, err := NewLifecycleService(manager, fixed); err != nil {
		t.Fatalf("NewLifecycleService() with reviewed go-git Lab error = %v", err)
	}
	fixed.Prepared.LabID = "example/unreviewed"
	if _, err := NewLifecycleService(manager, fixed); err == nil {
		t.Fatal("unreviewed Lab was accepted")
	}
}

type runnerProvider struct{}

func (runnerProvider) Start(context.Context, string, []byte) error { return nil }
func (runnerProvider) Stop(context.Context, string, []byte) error  { return nil }
func (runnerProvider) Delete(context.Context, string, []byte, bool) error {
	return nil
}
func (runnerProvider) Inspect(context.Context, string, []byte) (runtime.Resources, error) {
	return runtime.Resources{}, nil
}
func (runnerProvider) DiskUsage(context.Context, string) (int64, error) { return 0, nil }
