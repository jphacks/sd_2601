package training

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/jphacks/sd_2601/internal/lesson"
)

func TestLocalHandlerSeparatesManagementAndLearnerAuthorization(t *testing.T) {
	service := testService(t)
	lessonID := "command-injection/filebrowser-auth-hook"
	if _, err := service.CreateCourse(CreateCourseInput{OrganizationID: "local", ActorID: "admin", ID: "secure-course", Version: "1.0.0", Title: "研修", Lessons: []LessonRef{{LessonID: lessonID, LessonVersion: "1.0.0"}}, RequiredLessons: []LessonRef{{LessonID: lessonID, LessonVersion: "1.0.0"}}}); err != nil {
		t.Fatal(err)
	}
	assignments, err := service.CreateAssignments(CreateAssignmentsInput{OrganizationID: "local", ActorID: "admin", CourseID: "secure-course", CourseVersion: "1.0.0", LearnerIDs: []string{"learner"}, DueAt: time.Date(2027, 1, 1, 0, 0, 0, 0, time.UTC), AllowRetry: true})
	if err != nil {
		t.Fatal(err)
	}
	lessonRoot := t.TempDir()
	lessonData, err := os.ReadFile(filepath.Join("..", "..", "..", "lessons", "filebrowser-auth-hook.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(lessonRoot, "lesson.json"), lessonData, 0o600); err != nil {
		t.Fatal(err)
	}
	catalog, issues, err := lesson.LoadCatalog(lessonRoot, func(string) bool { return true })
	if err != nil || len(issues) != 0 {
		t.Fatalf("load catalog: %v %v", err, issues)
	}
	study, err := lesson.NewSessionStore(filepath.Join(t.TempDir(), "study"), catalog)
	if err != nil {
		t.Fatal(err)
	}
	handler, err := NewLocalHandler(service, study, http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) { writer.WriteHeader(http.StatusTeapot) }), LocalConfig{SessionToken: "learner-session-token", ManagementToken: "management-session-token", OrganizationID: "local", AdministratorID: "admin", LearnerID: "learner", AssignmentID: assignments[0].ID})
	if err != nil {
		t.Fatal(err)
	}
	call := func(method, path, body, header, token string) *httptest.ResponseRecorder {
		t.Helper()
		request := httptest.NewRequest(method, "http://127.0.0.1"+path, bytes.NewBufferString(body))
		if body != "" {
			request.Header.Set("Content-Type", "application/json")
		}
		if header != "" {
			request.Header.Set(header, token)
		}
		writer := httptest.NewRecorder()
		handler.ServeHTTP(writer, request)
		return writer
	}
	if status := call(http.MethodGet, "/api/training/courses", "", "", "").Code; status != http.StatusUnauthorized {
		t.Fatalf("unprotected management status = %d", status)
	}
	if status := call(http.MethodGet, "/api/training/courses?organizationId=other", "", "X-Reprokit-Management-Session", "management-session-token").Code; status != http.StatusForbidden {
		t.Fatalf("cross-organization status = %d", status)
	}
	if status := call(http.MethodPost, "/api/training/courses", `{"organizationId":"local","actorId":"other","id":"other","version":"1.0.0","title":"不正","lessons":[{"lessonId":"command-injection/filebrowser-auth-hook","lessonVersion":"1.0.0"}],"requiredLessons":[{"lessonId":"command-injection/filebrowser-auth-hook","lessonVersion":"1.0.0"}]}`, "X-Reprokit-Management-Session", "management-session-token").Code; status != http.StatusForbidden {
		t.Fatalf("spoofed actor status = %d", status)
	}
	if status := call(http.MethodGet, "/api/training/courses", "", "X-Reprokit-Management-Session", "management-session-token").Code; status != http.StatusOK {
		t.Fatalf("management status = %d", status)
	}
	context := decodeResponse[struct {
		Assignment Assignment `json:"assignment"`
	}](t, call(http.MethodGet, "/api/training/learner/assignment", "", "X-Reprokit-Session", "learner-session-token"), http.StatusOK)
	if context.Assignment.LearnerID != "learner" {
		t.Fatalf("unexpected learner assignment: %#v", context)
	}
	session, err := study.Create(lessonID, "1.0.0")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := study.SaveAnswer(session.ID, "trace-boundary", "保存済み回答"); err != nil {
		t.Fatal(err)
	}
	if status := call(http.MethodPost, "/api/training/learner/start", `{}`, "X-Reprokit-Session", "learner-session-token").Code; status != http.StatusOK {
		t.Fatalf("start status = %d", status)
	}
	response := call(http.MethodPost, "/api/training/learner/submissions", `{"studySessionId":"`+session.ID+`"}`, "X-Reprokit-Session", "learner-session-token")
	if response.Code != http.StatusCreated {
		t.Fatalf("submission status = %d: %s", response.Code, response.Body.String())
	}
	submissions, err := service.ListSubmissions("local", assignments[0].ID)
	if err != nil || len(submissions) != 1 || submissions[0].Answers["trace-boundary"] != "保存済み回答" {
		t.Fatalf("unexpected submissions: %#v %v", submissions, err)
	}
	audit := call(http.MethodGet, "/api/training/audit-events", "", "X-Reprokit-Management-Session", "management-session-token")
	if audit.Code != http.StatusOK || strings.Contains(audit.Body.String(), "保存済み回答") || !strings.Contains(audit.Body.String(), `"action":"assignment_status_changed"`) {
		t.Fatalf("unexpected protected audit response: status=%d body=%q", audit.Code, audit.Body.String())
	}
	export := call(http.MethodGet, "/api/training/exports/results.csv", "", "X-Reprokit-Management-Session", "management-session-token")
	if export.Code != http.StatusOK || strings.Contains(export.Body.String(), "保存済み回答") || !strings.Contains(export.Body.String(), "learner,secure-course,1.0.0,submitted") {
		t.Fatalf("unexpected protected CSV response: status=%d body=%q", export.Code, export.Body.String())
	}
}
