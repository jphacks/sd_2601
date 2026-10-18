package runnerapi

import (
	"context"
	"errors"

	"github.com/jphacks/sd_2601/internal/runtime"
)

var approvedLabIDs = map[string]struct{}{
	"reprokit/go-git-cve-2026-71557":    {},
	"vulhub/filebrowser-cve-2026-54088": {},
}

// FixedLab はWebから指定できるLesson参照と、Runnerだけが保持する実行定義を結び付ける。
type FixedLab struct {
	Lesson   LessonReference
	Prepared runtime.PreparedLab
}

// LifecycleService はHTTP入力を固定済みLab以外の実行定義へ変換しない。
type LifecycleService struct {
	manager *runtime.Manager
	fixed   FixedLab
}

func NewLifecycleService(manager *runtime.Manager, fixed FixedLab) (*LifecycleService, error) {
	if manager == nil {
		return nil, errors.New("runtime manager is required")
	}
	if fixed.Lesson.LessonID == "" || fixed.Lesson.LessonVersion == "" || fixed.Lesson.LabRef == "" {
		return nil, errors.New("fixed Lesson reference is required")
	}
	if _, approved := approvedLabIDs[fixed.Prepared.LabID]; !approved {
		return nil, errors.New("Lab is not approved for the local Runner")
	}
	return &LifecycleService{manager: manager, fixed: fixed}, nil
}

func (service *LifecycleService) Prepare(ctx context.Context, reference LessonReference) (runtime.Session, error) {
	if reference != service.fixed.Lesson {
		return runtime.Session{}, errors.New("Lesson reference does not identify the configured Lab")
	}
	return service.manager.Prepare(ctx, service.fixed.Prepared)
}

func (service *LifecycleService) Start(ctx context.Context, id string) (runtime.Session, error) {
	return service.manager.Start(ctx, id)
}

func (service *LifecycleService) Stop(ctx context.Context, id string) (runtime.Session, error) {
	return service.manager.Stop(ctx, id)
}

func (service *LifecycleService) Delete(ctx context.Context, id string, removeVolumes bool) (runtime.Session, error) {
	return service.manager.Delete(ctx, id, removeVolumes)
}

func (service *LifecycleService) Status(ctx context.Context, id string) (runtime.Session, error) {
	return service.manager.Status(ctx, id)
}

func (service *LifecycleService) ObserveMarker(ctx context.Context, id, reference string) (runtime.MarkerObservation, error) {
	return service.manager.ObserveMarker(ctx, id, reference)
}

func (service *LifecycleService) ReadLogs(ctx context.Context, id, reference string) (runtime.LogSnapshot, error) {
	return service.manager.ReadLogs(ctx, id, reference)
}

func (service *LifecycleService) RunAction(ctx context.Context, id, reference string, action runtime.ObservationAction) (runtime.ActionObservation, error) {
	return service.manager.RunAction(ctx, id, reference, action)
}
