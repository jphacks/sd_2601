package lab

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"

	"github.com/jphacks/sd_2601/internal/runtime"
)

var approvedPreparedLabIDs = map[string]struct{}{
	"reprokit/go-git-cve-2026-71557":    {},
	"vulhub/filebrowser-cve-2026-54088": {},
}

// ToPreparedLab は検証・実体化済みのLabだけをRunnerの固定入力へ変換する。
func ToPreparedLab(resolved ResolvedLab, materialized MaterializedSource) (runtime.PreparedLab, error) {
	manifestDigest := sha256.Sum256(resolved.Manifest.Bytes)
	composeDigest := sha256.Sum256(materialized.RuntimeCompose)
	if _, approved := approvedPreparedLabIDs[resolved.ID]; !approved || materialized.URL != resolved.Source.URL || materialized.Revision != resolved.Source.Revision || materialized.Subdirectory != resolved.Source.Subdirectory || len(resolved.Manifest.Bytes) == 0 || len(materialized.RuntimeCompose) == 0 || resolved.Manifest.SHA256 != hex.EncodeToString(manifestDigest[:]) || materialized.ComposeSHA256 != hex.EncodeToString(composeDigest[:]) || !hasRuntimeFile(materialized.Files, resolved.Runtime.File, materialized.ComposeSHA256) {
		return runtime.PreparedLab{}, errors.New("resolved Lab artifact is incomplete")
	}
	return runtime.PreparedLab{
		LabID:          resolved.ID,
		SourceRevision: resolved.Source.Revision,
		Artifact: runtime.Artifact{
			RegistryRevision:   resolved.Registry.Revision,
			ManifestPath:       resolved.Registry.ManifestPath,
			Manifest:           bytes.Clone(resolved.Manifest.Bytes),
			SourceURL:          resolved.Source.URL,
			SourceSubdirectory: resolved.Source.Subdirectory,
			RuntimeFile:        resolved.Runtime.File,
			Platform:           resolved.Runtime.Platform,
		},
		Compose:    bytes.Clone(materialized.RuntimeCompose),
		Guardrails: resolved.Runtime.Guardrails,
	}, nil
}

func hasRuntimeFile(files []SourceFile, runtimeFile, composeSHA256 string) bool {
	for _, file := range files {
		if file.Path == runtimeFile && file.SHA256 == composeSHA256 {
			return true
		}
	}
	return false
}
