package runtime

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/jphacks/sd_2601/internal/security"
	"gopkg.in/yaml.v3"
)

type State string

const (
	Prepared State = "prepared"
	Running  State = "running"
	Stopped  State = "stopped"
	Deleted  State = "deleted"
	Failed   State = "error"
)

var (
	ErrNotFound     = errors.New("Lab session was not found")
	ErrInvalidState = errors.New("Lab session is not in a state that permits this operation")
	idPattern       = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
)

type Endpoint struct {
	Service string `json:"service"`
	Address string `json:"address"`
	Port    int    `json:"port"`
}

type Container struct {
	Name  string `json:"name"`
	State string `json:"state"`
}

type Resources struct {
	Containers []Container `json:"containers"`
	Networks   []string    `json:"networks"`
	Volumes    []string    `json:"volumes"`
}

type Failure struct {
	Operation string `json:"operation"`
	Message   string `json:"message"`
}

// MarkerObservation はFile Browser比較Labで固定した無害なマーカーの観察結果である。
// 任意のコンテナ、パス、コマンドを受け取る用途には使わない。
type MarkerObservation struct {
	Service string `json:"service"`
	Exists  bool   `json:"exists"`
	Content string `json:"content,omitempty"`
}

// LogSnapshot は固定された比較対象サービスのログを容量制限付きで返す。
// 任意のコンテナ、コマンド、追従ストリームを公開する用途には使わない。
type LogSnapshot struct {
	Service   string `json:"service"`
	Content   string `json:"content"`
	Truncated bool   `json:"truncated"`
}

type ObservationAction string

const ListTmpAction ObservationAction = "list_tmp"

// ActionObservation はレビュー済みの固定検証アクションの結果である。
// 任意コマンドや任意引数の実行結果として使ってはならない。
type ActionObservation struct {
	Service   string            `json:"service"`
	Action    ObservationAction `json:"action"`
	Output    string            `json:"output"`
	Truncated bool              `json:"truncated"`
}

type Session struct {
	ID                 string              `json:"labSessionId"`
	LabID              string              `json:"labId"`
	SourceRevision     string              `json:"sourceRevision"`
	RegistryRevision   string              `json:"registryRevision"`
	Project            string              `json:"-"`
	State              State               `json:"state"`
	SafetyChecked      bool                `json:"safetyChecked"`
	ExternalExpose     bool                `json:"externalExposure"`
	Guardrails         security.Guardrails `json:"guardrails"`
	ExpiresAt          *time.Time          `json:"expiresAt,omitempty"`
	StopReason         string              `json:"stopReason,omitempty"`
	ManifestPath       string              `json:"-"`
	Manifest           []byte              `json:"-"`
	SourceURL          string              `json:"-"`
	SourceSubdirectory string              `json:"-"`
	RuntimeFile        string              `json:"-"`
	Platform           string              `json:"-"`
	SourceCompose      []byte              `json:"-"`
	Compose            []byte              `json:"-"`
	Lockfile           []byte              `json:"-"`
	Endpoints          []Endpoint          `json:"endpoints"`
	Resources          Resources           `json:"resources"`
	RetainedVolumes    []string            `json:"retainedVolumes"`
	Failure            *Failure            `json:"failure"`
	UpdatedAt          time.Time           `json:"updatedAt"`
}

type PreparedLab struct {
	LabID          string
	SourceRevision string
	Artifact       Artifact
	Compose        []byte
	Guardrails     security.Guardrails
}

// Provider はRunnerが所有するCompose Projectだけを操作する境界である。
type Provider interface {
	Start(context.Context, string, []byte) error
	Stop(context.Context, string, []byte) error
	Delete(context.Context, string, []byte, bool) error
	Inspect(context.Context, string, []byte) (Resources, error)
	DiskUsage(context.Context, string) (int64, error)
}

// EndpointChecker はDockerが要求されたloopback公開を実際に作成したか確認する追加境界である。
// Engineが設定を受理してもポート転送を作らない場合、起動成功として扱わない。
type EndpointChecker interface {
	CheckEndpoints(context.Context, string, []byte) error
}

// MarkerReader は承認済みの比較Labだけでマーカーを読むProviderの追加機能である。
// Lifecycleの基本Providerに読取り権限を要求しないため、無害なテストProviderを保てる。
type MarkerReader interface {
	ReadMarker(context.Context, string, []byte, string) (string, error)
}

// LogReader は承認済み比較Labの固定サービスから、制限済みのログだけを読む追加機能である。
// Lifecycleの基本Providerにログ閲覧権限を要求しないため、無害なテストProviderを保てる。
type LogReader interface {
	ReadLogs(context.Context, string, []byte, string) (LogSnapshot, error)
}

// ActionRunner はレビュー済みの固定検証アクションだけを実行する追加機能である。
// HTTP入力をコンテナコマンドや引数へ転用しない。
type ActionRunner interface {
	RunAction(context.Context, string, []byte, string, ObservationAction) (ActionObservation, error)
}

type Store interface {
	Load(context.Context, string) (Session, error)
	List(context.Context) ([]Session, error)
	Save(context.Context, Session) error
}

type Manager struct {
	store             Store
	provider          Provider
	locks             sync.Map
	timers            sync.Map
	diskTimers        sync.Map
	diskCheckInterval time.Duration
}

func NewManager(store Store, provider Provider) (*Manager, error) {
	if store == nil || provider == nil {
		return nil, errors.New("runtime store and provider are required")
	}
	return &Manager{store: store, provider: provider, diskCheckInterval: 2 * time.Second}, nil
}

// Prepare は安全性検査済みの固定Labを登録するだけで、コンテナを起動しない。
func (manager *Manager) Prepare(ctx context.Context, lab PreparedLab) (Session, error) {
	if !shaPattern.MatchString(lab.SourceRevision) || !isApprovedLabArtifact(lab.LabID, lab.Artifact) {
		return Session{}, errors.New("only a reviewed Lab revision may be prepared")
	}
	inspection, err := security.InspectComposeWithGuardrails(lab.Compose, lab.Guardrails)
	if err != nil {
		return Session{}, fmt.Errorf("inspect Compose: %w", err)
	}
	lockfile, err := createLock(lab, inspection.Normalized)
	if err != nil {
		return Session{}, err
	}
	endpoints, err := endpoints(inspection.Normalized)
	if err != nil {
		return Session{}, err
	}
	id, err := newID()
	if err != nil {
		return Session{}, err
	}
	session := Session{ID: id, LabID: lab.LabID, SourceRevision: lab.SourceRevision, RegistryRevision: lab.Artifact.RegistryRevision, Project: "reprokit_" + strings.ReplaceAll(id[:13], "-", ""), State: Prepared, SafetyChecked: true, Guardrails: lab.Guardrails, ManifestPath: lab.Artifact.ManifestPath, Manifest: append([]byte(nil), lab.Artifact.Manifest...), SourceURL: lab.Artifact.SourceURL, SourceSubdirectory: lab.Artifact.SourceSubdirectory, RuntimeFile: lab.Artifact.RuntimeFile, Platform: lab.Artifact.Platform, SourceCompose: append([]byte(nil), lab.Compose...), Compose: inspection.Normalized, Lockfile: lockfile, Endpoints: endpoints, UpdatedAt: time.Now().UTC()}
	if err := manager.store.Save(ctx, session); err != nil {
		return Session{}, err
	}
	return copySession(session), nil
}

func (manager *Manager) Start(ctx context.Context, id string) (Session, error) {
	session, err := manager.change(ctx, id, func(session *Session) error {
		if session.State != Prepared && session.State != Stopped {
			return ErrInvalidState
		}
		if !session.SafetyChecked {
			return errors.New("prepared Compose safety check no longer matches")
		}
		compose, err := verifyArtifact(*session)
		if err != nil {
			return err
		}
		if err := manager.provider.Start(ctx, session.Project, compose); err != nil {
			return manager.startFailure(ctx, session, err)
		}
		if checker, ok := manager.provider.(EndpointChecker); ok {
			if err := checker.CheckEndpoints(ctx, session.Project, compose); err != nil {
				return manager.startFailure(ctx, session, err)
			}
		}
		resources, err := manager.provider.Inspect(ctx, session.Project, session.Compose)
		if err != nil {
			return manager.startFailure(ctx, session, err)
		}
		usage, err := manager.provider.DiskUsage(ctx, session.Project)
		if err != nil {
			return manager.startFailure(ctx, session, err)
		}
		if usage > int64(session.Guardrails.DiskMiB)*1024*1024 {
			return manager.startFailure(ctx, session, errors.New("Lab disk usage exceeds the fixed limit"))
		}
		expiresAt := time.Now().UTC().Add(time.Duration(session.Guardrails.MaxRuntimeSeconds) * time.Second)
		session.State, session.Resources, session.Failure, session.ExpiresAt, session.StopReason = Running, resources, nil, &expiresAt, ""
		return nil
	})
	if err == nil && session.State == Running {
		manager.scheduleExpiration(session)
		manager.scheduleDiskLimit(session)
	}
	return session, err
}

func (manager *Manager) Stop(ctx context.Context, id string) (Session, error) {
	return manager.stop(ctx, id, "manual")
}

func (manager *Manager) stop(ctx context.Context, id, reason string) (Session, error) {
	session, err := manager.change(ctx, id, func(session *Session) error {
		if session.State == Deleted || session.State == Prepared || session.State == Stopped {
			return nil
		}
		if err := manager.provider.Stop(ctx, session.Project, session.Compose); err != nil {
			session.State, session.Failure = Failed, &Failure{Operation: "stop", Message: err.Error()}
			return err
		}
		resources, err := manager.provider.Inspect(ctx, session.Project, session.Compose)
		if err != nil {
			return err
		}
		session.State, session.Resources, session.Failure, session.StopReason = Stopped, resources, nil, reason
		return nil
	})
	if session.State != Running {
		manager.cancelExpiration(id)
		manager.cancelDiskLimit(id)
	}
	return session, err
}

func (manager *Manager) Delete(ctx context.Context, id string, removeVolumes bool) (Session, error) {
	session, err := manager.change(ctx, id, func(session *Session) error {
		if session.State == Deleted {
			return nil
		}
		if err := manager.provider.Delete(ctx, session.Project, session.Compose, removeVolumes); err != nil {
			session.State, session.Failure = Failed, &Failure{Operation: "delete", Message: err.Error()}
			return err
		}
		resources, err := manager.provider.Inspect(ctx, session.Project, session.Compose)
		if err != nil {
			return err
		}
		if !removeVolumes {
			session.RetainedVolumes, resources.Volumes = append([]string(nil), resources.Volumes...), nil
		}
		if len(resources.Containers) != 0 || len(resources.Networks) != 0 || len(resources.Volumes) != 0 {
			session.State, session.Resources, session.Failure = Failed, resources, &Failure{Operation: "delete", Message: "resources remain after delete"}
			return errors.New("resources remain after delete")
		}
		session.State, session.Resources, session.Failure = Deleted, Resources{}, nil
		return nil
	})
	if session.State != Running {
		manager.cancelExpiration(id)
		manager.cancelDiskLimit(id)
	}
	return session, err
}

// Recover は前回のRunnerが終了して残した実行中・失敗中のLabを回収する。
// 期限タイマーはプロセスに紐付くため、再起動後に継続実行させない。
func (manager *Manager) Recover(ctx context.Context) error {
	sessions, err := manager.store.List(ctx)
	if err != nil {
		return err
	}
	var cleanupErrors []error
	for _, candidate := range sessions {
		if candidate.State != Running && candidate.State != Failed {
			continue
		}
		manager.cancelExpiration(candidate.ID)
		manager.cancelDiskLimit(candidate.ID)
		_, err := manager.change(ctx, candidate.ID, func(session *Session) error {
			if err := manager.provider.Delete(ctx, session.Project, session.Compose, false); err != nil {
				session.State, session.Failure = Failed, &Failure{Operation: "recovery", Message: err.Error()}
				return err
			}
			resources, inspectErr := manager.provider.Inspect(ctx, session.Project, session.Compose)
			if inspectErr != nil {
				session.State, session.Failure = Failed, &Failure{Operation: "recovery", Message: inspectErr.Error()}
				return inspectErr
			}
			if len(resources.Containers) != 0 || len(resources.Networks) != 0 {
				session.State, session.Resources, session.Failure = Failed, resources, &Failure{Operation: "recovery", Message: "resources remain after recovery cleanup"}
				return errors.New("resources remain after recovery cleanup")
			}
			session.State, session.Resources, session.RetainedVolumes, session.Failure, session.StopReason = Stopped, Resources{}, append([]string(nil), resources.Volumes...), nil, "runner_restarted"
			return nil
		})
		if err != nil {
			cleanupErrors = append(cleanupErrors, fmt.Errorf("recover Lab session %s: %w", candidate.ID, err))
		}
	}
	return errors.Join(cleanupErrors...)
}

func (manager *Manager) scheduleExpiration(session Session) {
	if session.ExpiresAt == nil {
		return
	}
	manager.cancelExpiration(session.ID)
	delay := time.Until(*session.ExpiresAt)
	if delay < 0 {
		delay = 0
	}
	timer := time.AfterFunc(delay, func() {
		_, _ = manager.stop(context.Background(), session.ID, "expired")
	})
	manager.timers.Store(session.ID, timer)
}

func (manager *Manager) cancelExpiration(id string) {
	if value, loaded := manager.timers.LoadAndDelete(id); loaded {
		value.(*time.Timer).Stop()
	}
}

// scheduleDiskLimit はDockerの書込み量を定期的に確認し、固定済み上限を超えたLabを止める。
// Dockerのストレージドライバ依存のquotaには頼らず、監視できない場合も安全側で停止する。
func (manager *Manager) scheduleDiskLimit(session Session) {
	if session.State != Running {
		return
	}
	manager.cancelDiskLimit(session.ID)
	interval := manager.diskCheckInterval
	if interval <= 0 {
		interval = 2 * time.Second
	}
	timer := time.AfterFunc(interval, func() {
		manager.enforceDiskLimit(session.ID)
	})
	manager.diskTimers.Store(session.ID, timer)
}

func (manager *Manager) enforceDiskLimit(id string) {
	session, err := manager.store.Load(context.Background(), id)
	if err != nil || session.State != Running {
		return
	}
	usage, err := manager.provider.DiskUsage(context.Background(), session.Project)
	if err != nil {
		_, _ = manager.stop(context.Background(), id, "disk_monitor_unavailable")
		return
	}
	limit := int64(session.Guardrails.DiskMiB) * 1024 * 1024
	if usage > limit {
		_, _ = manager.stop(context.Background(), id, "disk_limit_exceeded")
		return
	}
	manager.scheduleDiskLimit(session)
}

func (manager *Manager) cancelDiskLimit(id string) {
	if value, loaded := manager.diskTimers.LoadAndDelete(id); loaded {
		value.(*time.Timer).Stop()
	}
}

func (manager *Manager) Status(ctx context.Context, id string) (Session, error) {
	return manager.change(ctx, id, func(session *Session) error {
		resources, err := manager.provider.Inspect(ctx, session.Project, session.Compose)
		if err == nil {
			session.Resources = resources
		}
		return err
	})
}

func (manager *Manager) startFailure(ctx context.Context, session *Session, startErr error) error {
	cleanupErr := manager.provider.Delete(ctx, session.Project, session.Compose, false)
	resources, _ := manager.provider.Inspect(ctx, session.Project, session.Compose)
	message := startErr.Error()
	if cleanupErr != nil {
		message += "; cleanup: " + cleanupErr.Error()
	}
	session.State, session.Resources, session.Failure = Failed, resources, &Failure{Operation: "start", Message: message}
	return errors.New(message)
}

func (manager *Manager) change(ctx context.Context, id string, operation func(*Session) error) (Session, error) {
	if !idPattern.MatchString(id) {
		return Session{}, errors.New("invalid Lab session ID")
	}
	lockValue, _ := manager.locks.LoadOrStore(id, &sync.Mutex{})
	lock := lockValue.(*sync.Mutex)
	lock.Lock()
	defer lock.Unlock()
	session, err := manager.store.Load(ctx, id)
	if err != nil {
		return Session{}, err
	}
	err = operation(&session)
	session.UpdatedAt = time.Now().UTC()
	if saveErr := manager.store.Save(ctx, session); saveErr != nil {
		return Session{}, saveErr
	}
	return copySession(session), err
}

func endpoints(compose []byte) ([]Endpoint, error) {
	var document struct {
		Services map[string]struct {
			DependsOn []string `yaml:"depends_on"`
			Ports     []string `yaml:"ports"`
		} `yaml:"services"`
	}
	if err := yaml.Unmarshal(compose, &document); err != nil {
		return nil, err
	}
	var result []Endpoint
	for service, definition := range document.Services {
		if !strings.HasPrefix(service, "reprokit_proxy_") {
			continue
		}
		if len(definition.DependsOn) != 1 || definition.DependsOn[0] == "" {
			return nil, errors.New("invalid Runner ingress proxy service")
		}
		originalService := definition.DependsOn[0]
		for _, value := range definition.Ports {
			parts := strings.Split(value, ":")
			if len(parts) != 3 || parts[0] != "127.0.0.1" {
				return nil, errors.New("non-loopback port in prepared Compose")
			}
			var port int
			if _, err := fmt.Sscanf(parts[1], "%d", &port); err != nil {
				return nil, err
			}
			result = append(result, Endpoint{Service: originalService, Address: parts[0], Port: port})
		}
	}
	return result, nil
}

func newID() (string, error) {
	var value [16]byte
	if _, err := rand.Read(value[:]); err != nil {
		return "", err
	}
	value[6] = value[6]&0x0f | 0x40
	value[8] = value[8]&0x3f | 0x80
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x", value[:4], value[4:6], value[6:8], value[8:10], value[10:]), nil
}

func copySession(session Session) Session {
	session.Compose = append([]byte(nil), session.Compose...)
	session.Manifest = append([]byte(nil), session.Manifest...)
	session.SourceCompose = append([]byte(nil), session.SourceCompose...)
	session.Lockfile = append([]byte(nil), session.Lockfile...)
	session.Endpoints = append([]Endpoint(nil), session.Endpoints...)
	session.Resources.Containers = append([]Container(nil), session.Resources.Containers...)
	session.Resources.Networks = append([]string(nil), session.Resources.Networks...)
	session.Resources.Volumes = append([]string(nil), session.Resources.Volumes...)
	session.RetainedVolumes = append([]string(nil), session.RetainedVolumes...)
	if session.Failure != nil {
		failure := *session.Failure
		session.Failure = &failure
	}
	return session
}
