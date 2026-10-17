package training

import (
	"bytes"
	"encoding/csv"
	"errors"
	"path/filepath"
	"testing"
	"time"
)

func testService(t *testing.T) *Service {
	t.Helper()
	store, err := NewStore(filepath.Join(t.TempDir(), "training"))
	if err != nil {
		t.Fatal(err)
	}
	service, err := NewService(store)
	if err != nil {
		t.Fatal(err)
	}
	service.now = func() time.Time { return time.Date(2026, 10, 17, 9, 0, 0, 0, time.UTC) }
	return service
}

func createCourse(t *testing.T, service *Service) Course {
	t.Helper()
	course, err := service.CreateCourse(CreateCourseInput{
		OrganizationID: "acme", ActorID: "trainer", ID: "secure-basics", Version: "1.0.0", Title: "安全な実装の基礎",
		Lessons: []LessonRef{{LessonID: "filebrowser/hook", LessonVersion: "1.0.0"}, {LessonID: "sample/fix", LessonVersion: "1.0.0"}}, RequiredLessons: []LessonRef{{LessonID: "filebrowser/hook", LessonVersion: "1.0.0"}, {LessonID: "sample/fix", LessonVersion: "1.0.0"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	return course
}

func TestCourseAssignmentSubmissionAndCompletionArePersisted(t *testing.T) {
	service := testService(t)
	createCourse(t, service)
	cohort, err := service.CreateCohort(CreateCohortInput{OrganizationID: "acme", ID: "new-hires", Name: "新入社員", LearnerIDs: []string{"alice", "bob"}})
	if err != nil {
		t.Fatal(err)
	}
	assignments, err := service.CreateAssignments(CreateAssignmentsInput{OrganizationID: "acme", ActorID: "trainer", CourseID: "secure-basics", CourseVersion: "1.0.0", CohortID: cohort.ID, DueAt: time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC), AllowRetry: true})
	if err != nil {
		t.Fatal(err)
	}
	if len(assignments) != 2 || assignments[0].Status != StatusAssigned || assignments[0].CohortID != cohort.ID {
		t.Fatalf("unexpected assignments: %#v", assignments)
	}
	assignment := assignments[0]
	if _, err := service.Start("acme", assignment.ID, "alice"); err != nil {
		t.Fatal(err)
	}
	first, err := service.Submit(SubmitInput{OrganizationID: "acme", AssignmentID: assignment.ID, LearnerID: "alice", LessonID: "filebrowser/hook", LessonVersion: "1.0.0", Answers: map[string]string{"cause": "認証前にフックを実行している"}})
	if err != nil {
		t.Fatal(err)
	}
	if first.SubmittedAt.IsZero() || first.Evaluation != EvaluationPending {
		t.Fatalf("unexpected submission: %#v", first)
	}
	_, afterFirst, completion, err := service.Review(ReviewInput{OrganizationID: "acme", SubmissionID: first.ID, EvaluatorID: "instructor", Evaluation: EvaluationAccepted})
	if err != nil {
		t.Fatal(err)
	}
	if completion != nil || afterFirst.Status != StatusSubmitted {
		t.Fatalf("first approved answer completed too early: %#v %#v", afterFirst, completion)
	}
	second, err := service.Submit(SubmitInput{OrganizationID: "acme", AssignmentID: assignment.ID, LearnerID: "alice", LessonID: "sample/fix", LessonVersion: "1.0.0", Answers: map[string]string{"prevention": "入力を検証する"}})
	if err != nil {
		t.Fatal(err)
	}
	_, completed, completion, err := service.Review(ReviewInput{OrganizationID: "acme", SubmissionID: second.ID, EvaluatorID: "instructor", Evaluation: EvaluationAccepted})
	if err != nil {
		t.Fatal(err)
	}
	if completed.Status != StatusCompleted || completion == nil || completion.LearnerID != "alice" {
		t.Fatalf("completion was not created from all accepted answers: %#v %#v", completed, completion)
	}

	reopenedStore, err := NewStore(service.store.root)
	if err != nil {
		t.Fatal(err)
	}
	reopened, err := NewService(reopenedStore)
	if err != nil {
		t.Fatal(err)
	}
	persisted, err := reopened.Assignment("acme", assignment.ID)
	if err != nil || persisted.Status != StatusCompleted {
		t.Fatalf("completion was not persisted: %#v %v", persisted, err)
	}
	submissions, err := reopened.ListSubmissions("acme", assignment.ID)
	hasCause := false
	for _, submission := range submissions {
		hasCause = hasCause || submission.Answers["cause"] != ""
	}
	if err != nil || len(submissions) != 2 || !hasCause {
		t.Fatalf("answers were not persisted: %#v %v", submissions, err)
	}
	if _, err := reopened.Assignment("other", assignment.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("organization boundary was bypassed: %v", err)
	}
}

func TestRetryRequiresPermissionAndExplicitRestart(t *testing.T) {
	service := testService(t)
	createCourse(t, service)
	assignments, err := service.CreateAssignments(CreateAssignmentsInput{OrganizationID: "acme", ActorID: "trainer", CourseID: "secure-basics", CourseVersion: "1.0.0", LearnerIDs: []string{"alice"}, DueAt: time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC), AllowRetry: true})
	if err != nil {
		t.Fatal(err)
	}
	assignment := assignments[0]
	if _, err := service.Start("acme", assignment.ID, "alice"); err != nil {
		t.Fatal(err)
	}
	submission, err := service.Submit(SubmitInput{OrganizationID: "acme", AssignmentID: assignment.ID, LearnerID: "alice", LessonID: "filebrowser/hook", LessonVersion: "1.0.0", Answers: map[string]string{"cause": "回答"}})
	if err != nil {
		t.Fatal(err)
	}
	_, retried, completion, err := service.Review(ReviewInput{OrganizationID: "acme", SubmissionID: submission.ID, EvaluatorID: "instructor", Evaluation: EvaluationNeedsRetry})
	if err != nil {
		t.Fatal(err)
	}
	if retried.Status != StatusNeedsRetry || completion != nil {
		t.Fatalf("unexpected retry result: %#v %#v", retried, completion)
	}
	resumed, err := service.Start("acme", assignment.ID, "alice")
	if err != nil || resumed.Status != StatusInProgress {
		t.Fatalf("retry was not explicitly restarted: %#v %v", resumed, err)
	}
}

func TestCourseAndAssignmentListsStayInsideOrganization(t *testing.T) {
	service := testService(t)
	createCourse(t, service)
	if _, err := service.CreateCourse(CreateCourseInput{OrganizationID: "other", ActorID: "trainer", ID: "other-course", Version: "1.0.0", Title: "別組織", Lessons: []LessonRef{{LessonID: "sample/fix", LessonVersion: "1.0.0"}}, RequiredLessons: []LessonRef{{LessonID: "sample/fix", LessonVersion: "1.0.0"}}}); err != nil {
		t.Fatal(err)
	}
	if _, err := service.CreateAssignments(CreateAssignmentsInput{OrganizationID: "acme", ActorID: "trainer", CourseID: "secure-basics", CourseVersion: "1.0.0", LearnerIDs: []string{"alice"}, DueAt: time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC), AllowRetry: true}); err != nil {
		t.Fatal(err)
	}
	courses, err := service.ListCourses("acme")
	if err != nil || len(courses) != 1 || courses[0].OrganizationID != "acme" {
		t.Fatalf("unexpected courses: %#v %v", courses, err)
	}
	assignments, err := service.ListAssignments("acme")
	if err != nil || len(assignments) != 1 || assignments[0].LearnerID != "alice" {
		t.Fatalf("unexpected assignments: %#v %v", assignments, err)
	}
}

func TestAuditEventsAndResultsCSVArePersistedWithoutLearnerAnswers(t *testing.T) {
	service := testService(t)
	createCourse(t, service)
	if _, err := service.CreateCourse(CreateCourseInput{
		OrganizationID: "acme", ActorID: "trainer", ID: "secure-basics", Version: "1.1.0", Title: "安全な実装の基礎",
		Lessons: []LessonRef{{LessonID: "filebrowser/hook", LessonVersion: "1.0.0"}}, RequiredLessons: []LessonRef{{LessonID: "filebrowser/hook", LessonVersion: "1.0.0"}},
	}); err != nil {
		t.Fatal(err)
	}
	assignments, err := service.CreateAssignments(CreateAssignmentsInput{OrganizationID: "acme", ActorID: "trainer", CourseID: "secure-basics", CourseVersion: "1.0.0", LearnerIDs: []string{"alice"}, DueAt: time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC), AllowRetry: true})
	if err != nil {
		t.Fatal(err)
	}
	assignment := assignments[0]
	if _, err := service.Start("acme", assignment.ID, "alice"); err != nil {
		t.Fatal(err)
	}
	for _, lesson := range []LessonRef{{LessonID: "filebrowser/hook", LessonVersion: "1.0.0"}, {LessonID: "sample/fix", LessonVersion: "1.0.0"}} {
		submission, err := service.Submit(SubmitInput{OrganizationID: "acme", AssignmentID: assignment.ID, LearnerID: "alice", LessonID: lesson.LessonID, LessonVersion: lesson.LessonVersion, Answers: map[string]string{"cause": "秘密にしなければならない回答"}})
		if err != nil {
			t.Fatal(err)
		}
		if _, _, _, err := service.Review(ReviewInput{OrganizationID: "acme", SubmissionID: submission.ID, EvaluatorID: "instructor", Evaluation: EvaluationAccepted}); err != nil {
			t.Fatal(err)
		}
	}
	events, err := service.ListAuditEvents("acme")
	if err != nil {
		t.Fatal(err)
	}
	actions := map[AuditAction]bool{}
	for _, event := range events {
		actions[event.Action] = true
		if event.ActorID == "" || event.OccurredAt.IsZero() {
			t.Fatalf("incomplete audit event: %#v", event)
		}
	}
	for _, action := range []AuditAction{AuditCoursePublished, AuditCourseUpdated, AuditAssignmentCreated, AuditAssignmentStatusChanged} {
		if !actions[action] {
			t.Fatalf("missing audit action %q in %#v", action, events)
		}
	}

	var output bytes.Buffer
	if err := service.WriteResultsCSV(&output, "acme"); err != nil {
		t.Fatal(err)
	}
	records, err := csv.NewReader(&output).ReadAll()
	if err != nil {
		t.Fatal(err)
	}
	if len(records) != 2 || records[1][0] != "alice" || records[1][1] != "secure-basics" || records[1][3] != string(StatusCompleted) || records[1][4] != "2026-10-17T09:00:00Z" || records[1][5] != string(EvaluationAccepted) {
		t.Fatalf("unexpected CSV records: %#v", records)
	}
	if bytes.Contains(output.Bytes(), []byte("秘密にしなければならない回答")) {
		t.Fatal("learner answer was exported")
	}
	stream := &failingCSVWriter{}
	if err := service.WriteResultsCSV(stream, "acme"); err == nil || stream.writes != 2 {
		t.Fatalf("CSV was not written incrementally: writes=%d err=%v", stream.writes, err)
	}

	reopenedStore, err := NewStore(service.store.root)
	if err != nil {
		t.Fatal(err)
	}
	reopened, err := NewService(reopenedStore)
	if err != nil {
		t.Fatal(err)
	}
	persisted, err := reopened.ListAuditEvents("acme")
	if err != nil || len(persisted) != len(events) {
		t.Fatalf("audit events were not persisted: %#v %v", persisted, err)
	}
}

func TestResultsCSVNeutralizesSpreadsheetFormulas(t *testing.T) {
	service := testService(t)
	version := `=HYPERLINK("https://example.invalid","open")`
	if _, err := service.CreateCourse(CreateCourseInput{OrganizationID: "acme", ActorID: "trainer", ID: "formula-course", Version: version, Title: "CSV検証", Lessons: []LessonRef{{LessonID: "sample/fix", LessonVersion: "1.0.0"}}, RequiredLessons: []LessonRef{{LessonID: "sample/fix", LessonVersion: "1.0.0"}}}); err != nil {
		t.Fatal(err)
	}
	if _, err := service.CreateAssignments(CreateAssignmentsInput{OrganizationID: "acme", ActorID: "trainer", CourseID: "formula-course", CourseVersion: version, LearnerIDs: []string{"alice"}, DueAt: time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC), AllowRetry: true}); err != nil {
		t.Fatal(err)
	}
	var output bytes.Buffer
	if err := service.WriteResultsCSV(&output, "acme"); err != nil {
		t.Fatal(err)
	}
	records, err := csv.NewReader(&output).ReadAll()
	if err != nil {
		t.Fatal(err)
	}
	if len(records) != 2 || records[1][2] != "'"+version {
		t.Fatalf("formula was not neutralized: %#v", records)
	}
}

type failingCSVWriter struct{ writes int }

func (writer *failingCSVWriter) Write(value []byte) (int, error) {
	writer.writes++
	if writer.writes > 1 {
		return 0, errors.New("stop after the CSV header")
	}
	return len(value), nil
}
