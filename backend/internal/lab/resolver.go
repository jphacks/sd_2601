package lab

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"regexp"
	"slices"
	"strings"

	"gopkg.in/yaml.v3"
)

var (
	commitPattern     = regexp.MustCompile(`^[0-9a-f]{40}$`)
	labIDPattern      = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?/[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$`)
	cvePattern        = regexp.MustCompile(`^CVE-[0-9]{4}-[0-9]{4,}$`)
	allowedSourceURLs = map[string]struct{}{
		"https://github.com/Saku0512/reprokit-go-git-cve-2026-71557-lab.git": {},
		"https://github.com/Saku0512/vulhub.git":                             {},
		"https://github.com/vulhub/vulhub.git":                               {},
	}
)

type registryIndex struct {
	RegistryVersion int                      `json:"registryVersion"`
	CVEs            map[string][]string      `json:"cves"`
	Labs            map[string]registryEntry `json:"labs"`
}

type registryEntry struct {
	Manifest string `json:"manifest"`
}

type manifest struct {
	APIVersion string           `yaml:"apiVersion"`
	Kind       string           `yaml:"kind"`
	Metadata   manifestMetadata `yaml:"metadata"`
	Spec       manifestSpec     `yaml:"spec"`
}

type manifestMetadata struct {
	ID   string `yaml:"id"`
	Name string `yaml:"name"`
}

type manifestSpec struct {
	CVEs    []string        `yaml:"cves"`
	Source  Source          `yaml:"source"`
	Runtime Runtime         `yaml:"runtime"`
	Target  *manifestTarget `yaml:"target,omitempty"`
	Checks  []manifestCheck `yaml:"checks,omitempty"`
}

type manifestTarget struct {
	Product             string                       `yaml:"product"`
	Version             string                       `yaml:"version,omitempty"`
	VulnerableComponent *manifestVulnerableComponent `yaml:"vulnerableComponent,omitempty"`
}

type manifestVulnerableComponent struct {
	Name    string `yaml:"name"`
	Version string `yaml:"version"`
}

type manifestCheck struct {
	Type    string `yaml:"type"`
	Service string `yaml:"service"`
	Port    int    `yaml:"port"`
}

// Resolver resolves a Lab only from one immutable Registry snapshot.
type Resolver struct{}

// Resolve validates the Registry index and selected Manifest, then returns the
// immutable Git source information needed by the fetcher.
func (Resolver) Resolve(registryRoot, registryRevision, labID string) (ResolvedLab, error) {
	if !commitPattern.MatchString(registryRevision) {
		return ResolvedLab{}, errors.New("registry revision must be a 40-character lowercase commit SHA")
	}
	if !labIDPattern.MatchString(labID) {
		return ResolvedLab{}, fmt.Errorf("invalid Lab ID %q", labID)
	}

	indexBytes, err := readFileWithin(registryRoot, "index.json", maxIndexBytes)
	if err != nil {
		return ResolvedLab{}, fmt.Errorf("read Registry index: %w", err)
	}
	index, err := decodeIndex(indexBytes)
	if err != nil {
		return ResolvedLab{}, fmt.Errorf("decode Registry index: %w", err)
	}
	if index.RegistryVersion != 1 {
		return ResolvedLab{}, fmt.Errorf("unsupported Registry version %d", index.RegistryVersion)
	}

	entry, found := index.Labs[labID]
	if !found {
		return ResolvedLab{}, fmt.Errorf("Lab %q is not present in the Registry", labID)
	}
	if err := validateRelativePath(entry.Manifest); err != nil {
		return ResolvedLab{}, fmt.Errorf("unsafe Manifest path for Lab %q: %w", labID, err)
	}

	manifestBytes, err := readFileWithin(registryRoot, entry.Manifest, maxManifestBytes)
	if err != nil {
		return ResolvedLab{}, fmt.Errorf("read Manifest for Lab %q: %w", labID, err)
	}
	definition, err := decodeManifest(manifestBytes)
	if err != nil {
		return ResolvedLab{}, fmt.Errorf("decode Manifest for Lab %q: %w", labID, err)
	}
	if err := validateManifest(definition, labID); err != nil {
		return ResolvedLab{}, fmt.Errorf("validate Manifest for Lab %q: %w", labID, err)
	}
	if err := validateIndexMapping(index, definition); err != nil {
		return ResolvedLab{}, fmt.Errorf("validate Registry mapping for Lab %q: %w", labID, err)
	}

	manifestDigest := sha256.Sum256(manifestBytes)
	return ResolvedLab{
		ID:      definition.Metadata.ID,
		Name:    definition.Metadata.Name,
		CVEs:    slices.Clone(definition.Spec.CVEs),
		Source:  definition.Spec.Source,
		Runtime: definition.Spec.Runtime,
		Registry: RegistryReference{
			Revision:     registryRevision,
			ManifestPath: entry.Manifest,
		},
		Manifest: ManifestReference{SHA256: hex.EncodeToString(manifestDigest[:]), Bytes: slices.Clone(manifestBytes)},
	}, nil
}

func decodeIndex(contents []byte) (registryIndex, error) {
	decoder := json.NewDecoder(bytes.NewReader(contents))
	decoder.DisallowUnknownFields()
	var index registryIndex
	if err := decoder.Decode(&index); err != nil {
		return registryIndex{}, err
	}
	if err := ensureJSONEOF(decoder); err != nil {
		return registryIndex{}, err
	}
	if index.CVEs == nil || index.Labs == nil {
		return registryIndex{}, errors.New("cves and labs must be objects")
	}
	return index, nil
}

func ensureJSONEOF(decoder *json.Decoder) error {
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		if err == nil {
			return errors.New("unexpected data after Registry index")
		}
		return err
	}
	return nil
}

func decodeManifest(contents []byte) (manifest, error) {
	decoder := yaml.NewDecoder(bytes.NewReader(contents))
	decoder.KnownFields(true)
	var definition manifest
	if err := decoder.Decode(&definition); err != nil {
		return manifest{}, err
	}
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		if err == nil {
			return manifest{}, errors.New("multiple YAML documents are not allowed")
		}
		return manifest{}, err
	}
	return definition, nil
}

func validateManifest(definition manifest, requestedLabID string) error {
	if definition.APIVersion != "reprokit.dev/v1alpha1" || definition.Kind != "Lab" {
		return errors.New("unsupported apiVersion or kind")
	}
	if definition.Metadata.ID != requestedLabID {
		return fmt.Errorf("metadata.id is %q", definition.Metadata.ID)
	}
	if strings.TrimSpace(definition.Metadata.Name) == "" {
		return errors.New("metadata.name must not be blank")
	}
	if len(definition.Spec.CVEs) == 0 {
		return errors.New("spec.cves must not be empty")
	}
	seenCVEs := make(map[string]struct{}, len(definition.Spec.CVEs))
	for _, cve := range definition.Spec.CVEs {
		if !cvePattern.MatchString(cve) {
			return fmt.Errorf("invalid CVE ID %q", cve)
		}
		if _, duplicate := seenCVEs[cve]; duplicate {
			return fmt.Errorf("duplicate CVE ID %q", cve)
		}
		seenCVEs[cve] = struct{}{}
	}
	if err := validateSource(definition.Spec.Source); err != nil {
		return err
	}
	if definition.Spec.Runtime.Type != "docker-compose" {
		return errors.New("spec.runtime.type must be docker-compose")
	}
	if err := validateRelativePath(definition.Spec.Runtime.File); err != nil {
		return fmt.Errorf("invalid runtime file: %w", err)
	}
	if !strings.HasSuffix(definition.Spec.Runtime.File, ".yml") && !strings.HasSuffix(definition.Spec.Runtime.File, ".yaml") {
		return errors.New("runtime file must end in .yml or .yaml")
	}
	if definition.Spec.Runtime.Platform != "linux/amd64" && definition.Spec.Runtime.Platform != "linux/arm64" {
		return fmt.Errorf("unsupported runtime platform %q", definition.Spec.Runtime.Platform)
	}
	if err := definition.Spec.Runtime.Guardrails.Validate(); err != nil {
		return fmt.Errorf("invalid runtime guardrails: %w", err)
	}
	return nil
}

func validateSource(source Source) error {
	if source.Type != "git" {
		return errors.New("spec.source.type must be git")
	}
	parsed, err := url.Parse(source.URL)
	if err != nil {
		return fmt.Errorf("invalid source URL: %w", err)
	}
	if parsed.Scheme != "https" || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return errors.New("source URL must be an HTTPS URL without credentials, query, or fragment")
	}
	if _, allowed := allowedSourceURLs[source.URL]; !allowed {
		return errors.New("source URL is not an approved Lab repository")
	}
	if !commitPattern.MatchString(source.Revision) {
		return errors.New("source revision must be a 40-character lowercase commit SHA")
	}
	if err := validateRelativePath(source.Subdirectory); err != nil {
		return fmt.Errorf("invalid source subdirectory: %w", err)
	}
	return nil
}

func validateIndexMapping(index registryIndex, definition manifest) error {
	manifestCVEs := make(map[string]struct{}, len(definition.Spec.CVEs))
	for _, cve := range definition.Spec.CVEs {
		manifestCVEs[cve] = struct{}{}
		if !slices.Contains(index.CVEs[cve], definition.Metadata.ID) {
			return fmt.Errorf("CVE index %q does not reference the Lab", cve)
		}
	}

	for cve, labIDs := range index.CVEs {
		seen := make(map[string]struct{}, len(labIDs))
		for _, indexedLabID := range labIDs {
			if _, duplicate := seen[indexedLabID]; duplicate {
				return fmt.Errorf("CVE index %q contains duplicate Lab %q", cve, indexedLabID)
			}
			seen[indexedLabID] = struct{}{}
			if indexedLabID == definition.Metadata.ID {
				if _, declared := manifestCVEs[cve]; !declared {
					return fmt.Errorf("CVE index %q references the Lab but the Manifest does not", cve)
				}
			}
		}
	}
	return nil
}
