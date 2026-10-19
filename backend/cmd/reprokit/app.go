package main

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/jphacks/sd_2601/internal/identity"
	"github.com/jphacks/sd_2601/internal/lab"
	"github.com/jphacks/sd_2601/internal/lesson"
	"github.com/jphacks/sd_2601/internal/runnerapi"
	"github.com/jphacks/sd_2601/internal/runtime"
	"github.com/jphacks/sd_2601/internal/training"
)

const (
	lessonID           = "command-injection/filebrowser-auth-hook"
	lessonVersion      = "1.0.0"
	labID              = "vulhub/filebrowser-cve-2026-54088"
	goGitLessonID      = "path-traversal/go-git-loose-reference"
	goGitLessonVersion = "1.0.0"
	goGitLabID         = "reprokit/go-git-cve-2026-71557"
)

type reviewedLesson struct {
	ID      string
	Version string
	LabID   string
}

var reviewedLessons = []reviewedLesson{
	{ID: lessonID, Version: lessonVersion, LabID: labID},
	{ID: goGitLessonID, Version: goGitLessonVersion, LabID: goGitLabID},
}

type configuration struct {
	repository, state                          string
	organizationID, administratorID, learnerID string
	administratorSubject                       string
	oidcIssuer, oidcClientID, oidcClientSecret string
	oidcRedirectURL                            string
}
type materializeSource func(context.Context, lab.ResolvedLab, string) (lab.MaterializedSource, error)
type application struct {
	server          *runnerapi.LocalServer
	snapshot        string
	managementToken string
	organizationID  string
	administratorID string
	oidcEnabled     bool
}

func newApplication(ctx context.Context, config configuration, provider runtime.Provider, materialize materializeSource) (*application, error) {
	if !filepath.IsAbs(config.repository) || !filepath.IsAbs(config.state) || provider == nil || materialize == nil {
		return nil, errors.New("absolute application paths and Runner dependencies are required")
	}
	if config.organizationID == "" {
		config.organizationID = "local"
	}
	if config.administratorID == "" {
		config.administratorID = "admin"
	}
	if config.learnerID == "" {
		config.learnerID = "local-learner"
	}
	oidcEnabled, err := validOIDCConfiguration(config)
	if err != nil {
		return nil, err
	}
	if config.administratorSubject == "" {
		if oidcEnabled {
			return nil, errors.New("OIDC administrator subject is required")
		}
		config.administratorSubject = "local:" + config.administratorID
	}
	for _, directory := range []string{config.state, filepath.Join(config.state, "labs"), filepath.Join(config.state, "study"), filepath.Join(config.state, "training"), filepath.Join(config.state, "identity")} {
		if err := privateDirectory(directory); err != nil {
			return nil, err
		}
	}
	root, err := os.MkdirTemp(config.state, ".catalog-*")
	if err != nil {
		return nil, err
	}
	cleanup := true
	defer func() {
		if cleanup {
			_ = os.RemoveAll(root)
		}
	}()
	readContext, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	revision, err := snapshot(readContext, config.repository, root)
	if err != nil {
		return nil, err
	}
	resolvedLabs := make(map[string]lab.ResolvedLab, len(reviewedLessons))
	for _, reviewed := range reviewedLessons {
		resolved, err := (lab.Resolver{}).Resolve(filepath.Join(root, "registry"), revision, reviewed.LabID)
		if err != nil {
			return nil, err
		}
		resolvedLabs[reviewed.LabID] = resolved
	}
	catalog, issues, err := lesson.LoadCatalog(filepath.Join(root, "lessons"), func(id string) bool {
		_, allowed := resolvedLabs[id]
		return allowed
	})
	if err != nil {
		return nil, err
	}
	if len(issues) > 0 {
		return nil, fmt.Errorf("committed Lesson was rejected: %v", issues[0])
	}
	for _, reviewed := range reviewedLessons {
		value, exists := catalog.Get(reviewed.ID, reviewed.Version)
		if !exists {
			return nil, fmt.Errorf("reviewed Lesson Version is missing: %s@%s", reviewed.ID, reviewed.Version)
		}
		for _, ref := range []string{"vulnerable", "fixed"} {
			found := false
			for _, reference := range value.Spec.Labs {
				if reference.Ref == ref && reference.LabID == reviewed.LabID {
					found = true
				}
			}
			if !found {
				return nil, fmt.Errorf("Lesson %s comparison references do not match the Registry", reviewed.ID)
			}
		}
	}
	study, err := lesson.NewSessionStore(filepath.Join(config.state, "study"), catalog)
	if err != nil {
		return nil, err
	}
	labs, err := runtime.NewFileStore(filepath.Join(config.state, "labs"))
	if err != nil {
		return nil, err
	}
	manager, err := runtime.NewManager(labs, provider)
	if err != nil {
		return nil, err
	}
	if err := manager.Recover(ctx); err != nil {
		return nil, fmt.Errorf("recover Lab resources from a previous Runner: %w", err)
	}
	service := &lazyService{
		manager:     manager,
		materialize: materialize,
		state:       config.state,
		labs:        make(map[runnerapi.LessonReference]lab.ResolvedLab, len(reviewedLessons)),
		services:    make(map[runnerapi.LessonReference]*runnerapi.LifecycleService, len(reviewedLessons)),
	}
	for _, reviewed := range reviewedLessons {
		service.labs[runnerapi.LessonReference{LessonID: reviewed.ID, LessonVersion: reviewed.Version, LabRef: "vulnerable"}] = resolvedLabs[reviewed.LabID]
	}
	server, err := lesson.NewLocalServer(catalog, study, service)
	if err != nil {
		return nil, err
	}
	trainingStore, err := training.NewStore(filepath.Join(config.state, "training"))
	if err != nil {
		server.Listener.Close()
		return nil, err
	}
	lessonSummaries := catalog.List()
	materials := make([]training.Material, 0, len(lessonSummaries))
	for _, summary := range lessonSummaries {
		materials = append(materials, training.Material{LessonID: summary.ID, LessonVersion: summary.Version, Title: summary.Title, Product: summary.Product, DurationMinutes: summary.DurationMinutes, CVEs: summary.CVEs})
	}
	trainingService, err := training.NewService(trainingStore, materials)
	if err != nil {
		server.Listener.Close()
		return nil, err
	}
	identityStore, err := identity.NewStore(filepath.Join(config.state, "identity"))
	if err != nil {
		server.Listener.Close()
		return nil, err
	}
	identityService, err := identity.NewService(identityStore)
	if err != nil {
		server.Listener.Close()
		return nil, err
	}
	if err := ensureLocalIdentities(identityService, config); err != nil {
		server.Listener.Close()
		return nil, err
	}
	var oidcAuthenticator *identity.OIDCAuthenticator
	if oidcEnabled {
		administrator, err := identityService.PrincipalForSubject(config.organizationID, config.administratorSubject)
		if err != nil || identityService.Authorize(administrator, identity.PermissionManageIdentity) != nil {
			server.Listener.Close()
			return nil, errors.New("OIDC administrator subject must identify an organization administrator")
		}
		if err := ensureOIDCConfiguration(identityService, config); err != nil {
			server.Listener.Close()
			return nil, err
		}
		oidcAuthenticator, err = identity.NewOIDCAuthenticator(identityService, http.DefaultClient, func(organizationID string) (string, error) {
			if organizationID != config.organizationID {
				return "", identity.ErrNotFound
			}
			return config.oidcClientSecret, nil
		})
		if err != nil {
			server.Listener.Close()
			return nil, err
		}
	}
	assignment, err := ensureLocalAssignment(trainingService, config)
	if err != nil {
		server.Listener.Close()
		return nil, err
	}
	managementToken, err := localSecret()
	if err != nil {
		server.Listener.Close()
		return nil, err
	}
	server.Handler, err = training.NewLocalHandler(trainingService, study, server.Handler, training.LocalConfig{SessionToken: server.SessionToken, ManagementToken: managementToken, OrganizationID: config.organizationID, AdministratorID: config.administratorID, LearnerID: config.learnerID, AssignmentID: assignment.ID, Identity: identityService, OIDC: oidcAuthenticator})
	if err != nil {
		server.Listener.Close()
		return nil, err
	}
	cleanup = false
	return &application{server: server, snapshot: root, managementToken: managementToken, organizationID: config.organizationID, administratorID: config.administratorID, oidcEnabled: oidcEnabled}, nil
}

func validOIDCConfiguration(config configuration) (bool, error) {
	values := []string{config.oidcIssuer, config.oidcClientID, config.oidcClientSecret, config.oidcRedirectURL}
	configured := 0
	for _, value := range values {
		if value != "" {
			configured++
		}
	}
	if configured == 0 {
		return false, nil
	}
	if configured != len(values) {
		return false, errors.New("all OIDC settings are required")
	}
	return true, nil
}

func ensureOIDCConfiguration(service *identity.Service, config configuration) error {
	current, err := service.OIDCConfiguration(config.organizationID)
	if err == nil && current.Issuer == config.oidcIssuer && current.ClientID == config.oidcClientID && current.RedirectURL == config.oidcRedirectURL {
		return nil
	}
	if err != nil && !errors.Is(err, identity.ErrNotFound) {
		return err
	}
	_, err = service.ConfigureOIDC(
		identity.Principal{OrganizationID: config.organizationID, UserID: config.administratorID},
		config.oidcIssuer,
		config.oidcClientID,
		config.oidcRedirectURL,
	)
	return err
}

func ensureLocalIdentities(service *identity.Service, config configuration) error {
	principal := identity.Principal{OrganizationID: config.organizationID, UserID: config.administratorID}
	if _, err := service.Organization(config.organizationID); errors.Is(err, identity.ErrNotFound) {
		_, _, err = service.Bootstrap(identity.BootstrapInput{
			OrganizationID:   config.organizationID,
			OrganizationName: "Local organization",
			UserID:           config.administratorID,
			Subject:          config.administratorSubject,
			Email:            config.administratorID + "@local.invalid",
			DisplayName:      "Local administrator",
		})
		if err != nil {
			return err
		}
	} else if err != nil {
		return err
	} else if err := service.Authorize(principal, identity.PermissionManageOrganization); err != nil {
		return errors.New("configured local administrator is unavailable")
	}
	if config.learnerID == config.administratorID {
		return nil
	}
	if _, err := service.User(principal, config.learnerID); errors.Is(err, identity.ErrNotFound) {
		_, err = service.CreateUser(principal, identity.CreateUserInput{
			ID:          config.learnerID,
			Subject:     "local:" + config.learnerID,
			Email:       config.learnerID + "@local.invalid",
			DisplayName: "Local learner",
			Roles:       []identity.Role{identity.RoleLearner},
		})
		return err
	} else if err != nil {
		return err
	}
	return service.Authorize(identity.Principal{OrganizationID: config.organizationID, UserID: config.learnerID}, identity.PermissionAccessLearning)
}

func ensureLocalAssignment(service *training.Service, config configuration) (training.Assignment, error) {
	assignments, err := service.ListAssignments(config.organizationID)
	if err != nil {
		return training.Assignment{}, err
	}
	for _, assignment := range assignments {
		if assignment.LessonID == lessonID && assignment.LessonVersion == lessonVersion && assignment.LearnerID == config.learnerID {
			return assignment, nil
		}
	}
	created, err := service.CreateAssignments(training.CreateAssignmentsInput{OrganizationID: config.organizationID, ActorID: config.administratorID, LessonID: lessonID, LessonVersion: lessonVersion, LearnerIDs: []string{config.learnerID}, DueAt: time.Now().UTC().AddDate(1, 0, 0), AllowRetry: true})
	if err != nil {
		return training.Assignment{}, err
	}
	return created[0], nil
}

func localSecret() (string, error) {
	value := make([]byte, 32)
	if _, err := rand.Read(value); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(value), nil
}

func privateDirectory(path string) error {
	if err := os.MkdirAll(path, 0o700); err != nil {
		return err
	}
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if !info.IsDir() || info.Mode().Perm()&0o077 != 0 {
		return errors.New("Runner state directories must be private real directories (0700)")
	}
	return nil
}

func (app *application) Close() { _ = app.server.Listener.Close(); _ = os.RemoveAll(app.snapshot) }

// 起動と教材閲覧では取得もDocker操作もしない。最初のPrepareだけが固定ソースを取得する。
type lazyService struct {
	manager     *runtime.Manager
	materialize materializeSource
	state       string
	mu          sync.Mutex
	labs        map[runnerapi.LessonReference]lab.ResolvedLab
	services    map[runnerapi.LessonReference]*runnerapi.LifecycleService
}

func (service *lazyService) Prepare(ctx context.Context, reference runnerapi.LessonReference) (runtime.Session, error) {
	resolved, approved := service.labs[reference]
	if !approved {
		return runtime.Session{}, errors.New("Lesson reference does not identify a reviewed comparison Lab")
	}
	service.mu.Lock()
	defer service.mu.Unlock()
	fixed := service.services[reference]
	if fixed == nil {
		root, err := os.MkdirTemp(service.state, ".source-*")
		if err != nil {
			return runtime.Session{}, err
		}
		defer os.RemoveAll(root)
		fetchContext, cancel := context.WithTimeout(ctx, 90*time.Second)
		defer cancel()
		materialized, err := service.materialize(fetchContext, resolved, filepath.Join(root, "lab"))
		if err != nil {
			return runtime.Session{}, err
		}
		prepared, err := lab.ToPreparedLab(resolved, materialized)
		if err != nil {
			return runtime.Session{}, err
		}
		fixed, err = runnerapi.NewLifecycleService(service.manager, runnerapi.FixedLab{Lesson: reference, Prepared: prepared})
		if err != nil {
			return runtime.Session{}, err
		}
		service.services[reference] = fixed
	}
	return fixed.Prepare(ctx, reference)
}
func (service *lazyService) Start(ctx context.Context, id string) (runtime.Session, error) {
	return service.manager.Start(ctx, id)
}
func (service *lazyService) Stop(ctx context.Context, id string) (runtime.Session, error) {
	return service.manager.Stop(ctx, id)
}
func (service *lazyService) Delete(ctx context.Context, id string, remove bool) (runtime.Session, error) {
	return service.manager.Delete(ctx, id, remove)
}
func (service *lazyService) Status(ctx context.Context, id string) (runtime.Session, error) {
	return service.manager.Status(ctx, id)
}
func (service *lazyService) ObserveMarker(ctx context.Context, id, reference string) (runtime.MarkerObservation, error) {
	return service.manager.ObserveMarker(ctx, id, reference)
}

func (service *lazyService) ReadLogs(ctx context.Context, id, reference string) (runtime.LogSnapshot, error) {
	return service.manager.ReadLogs(ctx, id, reference)
}

func (service *lazyService) RunAction(ctx context.Context, id, reference string, action runtime.ObservationAction) (runtime.ActionObservation, error) {
	return service.manager.RunAction(ctx, id, reference, action)
}
