package runtime

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"maps"
	"regexp"
	"strings"

	"github.com/jphacks/sd_2601/internal/security"
	"gopkg.in/yaml.v3"
)

var (
	shaPattern         = regexp.MustCompile(`^[0-9a-f]{40}$`)
	pathPattern        = regexp.MustCompile(`^[A-Za-z0-9._-]+(?:/[A-Za-z0-9._-]+)*$`)
	imagePattern       = regexp.MustCompile(`^(.+)@(sha256:[0-9a-f]{64})$`)
	serviceNamePattern = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_.-]*$`)
)

type lockDocument struct {
	LockVersion int `yaml:"lockVersion"`
	Lab         string
	Registry    struct {
		Revision     string `yaml:"revision"`
		ManifestPath string `yaml:"manifestPath"`
	} `yaml:"registry"`
	Manifest struct {
		SHA256 string `yaml:"sha256"`
	} `yaml:"manifest"`
	Source struct {
		URL           string `yaml:"url"`
		Revision      string `yaml:"revision"`
		Subdirectory  string `yaml:"subdirectory"`
		ComposeSHA256 string `yaml:"composeSha256"`
		Files         []struct {
			Path   string `yaml:"path"`
			SHA256 string `yaml:"sha256"`
		} `yaml:"files"`
	} `yaml:"source"`
	Runtime struct {
		Type                  string              `yaml:"type"`
		Platform              string              `yaml:"platform"`
		ResolvedComposeSHA256 string              `yaml:"resolvedComposeSha256"`
		Guardrails            security.Guardrails `yaml:"guardrails"`
	} `yaml:"runtime"`
	Images map[string]lockedImage `yaml:"images"`
}

type lockedImage struct {
	Reference string `yaml:"reference"`
	Digest    string `yaml:"digest"`
	Platform  string `yaml:"platform"`
}

// Artifact は解決済みの固定LabをPrepareへ渡すための非公開実行入力である。
type Artifact struct {
	RegistryRevision   string
	ManifestPath       string
	Manifest           []byte
	SourceURL          string
	SourceSubdirectory string
	RuntimeFile        string
	Platform           string
}

// approvedLabArtifact はレビュー済みLabごとの不変な取得元を定義する。
// ここにないLabや取得元を、実行時入力から追加することは許可しない。
type approvedLabArtifact struct {
	SourceURL          string
	SourceSubdirectory string
	Platform           string
}

var approvedLabArtifacts = map[string]approvedLabArtifact{
	"vulhub/filebrowser-cve-2026-54088": {
		SourceURL:          "https://github.com/Saku0512/vulhub.git",
		SourceSubdirectory: "filebrowser/CVE-2026-54088",
		Platform:           "linux/amd64",
	},
	"reprokit/go-git-cve-2026-71557": {
		SourceURL:          "https://github.com/Saku0512/reprokit-go-git-cve-2026-71557-lab.git",
		SourceSubdirectory: "lab",
		Platform:           "linux/amd64",
	},
}

func isApprovedLabArtifact(labID string, artifact Artifact) bool {
	expected, ok := approvedLabArtifacts[labID]
	return ok && artifact.SourceURL == expected.SourceURL && artifact.SourceSubdirectory == expected.SourceSubdirectory && artifact.Platform == expected.Platform
}

func createLock(lab PreparedLab, normalized []byte) ([]byte, error) {
	if !shaPattern.MatchString(lab.Artifact.RegistryRevision) || !validRelativePath(lab.Artifact.ManifestPath) || !validRelativePath(lab.Artifact.RuntimeFile) || len(lab.Artifact.Manifest) == 0 || !isApprovedLabArtifact(lab.LabID, lab.Artifact) {
		return nil, errors.New("fixed Lab artifact is incomplete")
	}
	if err := lab.Guardrails.Validate(); err != nil {
		return nil, fmt.Errorf("invalid Lab guardrails: %w", err)
	}
	images, err := composeImages(normalized, lab.Artifact.Platform)
	if err != nil {
		return nil, err
	}
	document := lockDocument{LockVersion: 1, Lab: lab.LabID, Images: images}
	document.Registry.Revision = lab.Artifact.RegistryRevision
	document.Registry.ManifestPath = lab.Artifact.ManifestPath
	document.Manifest.SHA256 = digest(lab.Artifact.Manifest)
	document.Source.URL = lab.Artifact.SourceURL
	document.Source.Revision = lab.SourceRevision
	document.Source.Subdirectory = lab.Artifact.SourceSubdirectory
	document.Source.ComposeSHA256 = digest(lab.Compose)
	document.Source.Files = append(document.Source.Files, struct {
		Path   string `yaml:"path"`
		SHA256 string `yaml:"sha256"`
	}{Path: lab.Artifact.RuntimeFile, SHA256: digest(lab.Compose)})
	document.Runtime.Type = "docker-compose"
	document.Runtime.Platform = lab.Artifact.Platform
	document.Runtime.ResolvedComposeSHA256 = digest(normalized)
	document.Runtime.Guardrails = lab.Guardrails
	contents, err := yaml.Marshal(document)
	if err != nil {
		return nil, fmt.Errorf("encode lockfile: %w", err)
	}
	return contents, nil
}

func verifyArtifact(session Session) ([]byte, error) {
	artifact := Artifact{SourceURL: session.SourceURL, SourceSubdirectory: session.SourceSubdirectory, Platform: session.Platform}
	if !shaPattern.MatchString(session.SourceRevision) || !shaPattern.MatchString(session.RegistryRevision) || !isApprovedLabArtifact(session.LabID, artifact) {
		return nil, errors.New("stored Lab identity is invalid")
	}
	if len(session.Manifest) == 0 || !validRelativePath(session.ManifestPath) || !validRelativePath(session.RuntimeFile) {
		return nil, errors.New("stored Lab artifact is incomplete")
	}
	inspection, err := security.InspectComposeWithGuardrails(session.SourceCompose, session.Guardrails)
	if err != nil || string(inspection.Normalized) != string(session.Compose) {
		return nil, errors.New("stored Compose safety check no longer matches")
	}
	document, err := decodeLock(session.Lockfile)
	if err != nil {
		return nil, err
	}
	images, err := composeImages(inspection.Normalized, session.Platform)
	if err != nil {
		return nil, err
	}
	if document.LockVersion != 1 || document.Lab != session.LabID ||
		document.Registry.Revision != session.RegistryRevision || document.Registry.ManifestPath != session.ManifestPath ||
		document.Manifest.SHA256 != digest(session.Manifest) || document.Source.URL != session.SourceURL || document.Source.Revision != session.SourceRevision || document.Source.Subdirectory != session.SourceSubdirectory ||
		document.Source.ComposeSHA256 != digest(session.SourceCompose) || document.Runtime.Type != "docker-compose" || document.Runtime.Platform != session.Platform ||
		document.Runtime.ResolvedComposeSHA256 != digest(inspection.Normalized) || document.Runtime.Guardrails != session.Guardrails || !maps.Equal(document.Images, images) {
		return nil, errors.New("stored lockfile no longer matches the Lab artifact")
	}
	if len(document.Source.Files) != 1 || document.Source.Files[0].Path != session.RuntimeFile || document.Source.Files[0].SHA256 != digest(session.SourceCompose) {
		return nil, errors.New("stored lockfile source files do not match the Lab artifact")
	}
	return inspection.Normalized, nil
}

func decodeLock(contents []byte) (lockDocument, error) {
	decoder := yaml.NewDecoder(bytes.NewReader(contents))
	decoder.KnownFields(true)
	var document lockDocument
	if err := decoder.Decode(&document); err != nil {
		return lockDocument{}, fmt.Errorf("decode lockfile: %w", err)
	}
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		return lockDocument{}, errors.New("lockfile contains multiple documents")
	}
	return document, nil
}

func composeImages(compose []byte, platform string) (map[string]lockedImage, error) {
	var document struct {
		Services map[string]struct {
			Image string `yaml:"image"`
		} `yaml:"services"`
	}
	if err := yaml.Unmarshal(compose, &document); err != nil {
		return nil, err
	}
	images := make(map[string]lockedImage, len(document.Services))
	for service, definition := range document.Services {
		match := imagePattern.FindStringSubmatch(definition.Image)
		if !serviceNamePattern.MatchString(service) || len(match) != 3 {
			return nil, errors.New("Compose service image is not pinned by digest")
		}
		images[service] = lockedImage{Reference: match[1], Digest: match[2], Platform: platform}
	}
	if len(images) == 0 {
		return nil, errors.New("Compose does not contain services")
	}
	return images, nil
}

func digest(contents []byte) string {
	sum := sha256.Sum256(contents)
	return hex.EncodeToString(sum[:])
}

func validRelativePath(value string) bool {
	if !pathPattern.MatchString(value) {
		return false
	}
	for _, part := range strings.Split(value, "/") {
		if part == "." || part == ".." {
			return false
		}
	}
	return true
}
