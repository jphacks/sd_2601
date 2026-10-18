package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
)

var revisionPattern = regexp.MustCompile(`^[0-9a-f]{40}$`)

// 公開する教材とRegistryを一つのコミットから読み、作業ツリーの未レビュー変更を混ぜない。
func snapshot(ctx context.Context, repository, destination string) (string, error) {
	revisionBytes, err := gitRead(ctx, repository, 256, "rev-parse", "--verify", "HEAD^{commit}")
	if err != nil {
		return "", err
	}
	revision := strings.TrimSpace(string(revisionBytes))
	if !revisionPattern.MatchString(revision) {
		return "", errors.New("invalid repository revision")
	}
	for _, path := range []string{
		"registry/index.json",
		"registry/manifests/reprokit/go-git-cve-2026-71557.yaml",
		"registry/manifests/vulhub/filebrowser-cve-2026-54088.yaml",
		"lessons/filebrowser-auth-hook.json",
		"lessons/go-git-loose-reference-path-traversal.json",
	} {
		entry, err := gitRead(ctx, repository, 4096, "ls-tree", revision, "--", path)
		if err != nil {
			return "", err
		}
		fields := strings.Fields(string(entry))
		if len(fields) != 4 || fields[0] != "100644" || fields[1] != "blob" || fields[3] != path {
			return "", fmt.Errorf("committed artifact is not a regular file: %s", path)
		}
		contents, err := gitRead(ctx, repository, 4<<20, "show", revision+":"+path)
		if err != nil {
			return "", err
		}
		target := filepath.Join(destination, filepath.FromSlash(path))
		if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
			return "", err
		}
		if err := os.WriteFile(target, contents, 0o600); err != nil {
			return "", err
		}
	}
	return revision, nil
}

type boundedOutput struct {
	bytes.Buffer
	limit int
}

func (output *boundedOutput) Write(value []byte) (int, error) {
	if len(value) > output.limit-output.Len() {
		return 0, errors.New("Git output exceeds limit")
	}
	return output.Buffer.Write(value)
}

func gitRead(ctx context.Context, repository string, limit int, args ...string) ([]byte, error) {
	command := exec.CommandContext(ctx, "git", append([]string{"-C", repository}, args...)...)
	for _, value := range os.Environ() {
		if !strings.HasPrefix(value, "GIT_") {
			command.Env = append(command.Env, value)
		}
	}
	command.Env = append(command.Env, "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL=/dev/null", "GIT_NO_REPLACE_OBJECTS=1")
	output := &boundedOutput{limit: limit}
	command.Stdout = output
	command.Stderr = &boundedOutput{limit: 64 << 10}
	if err := command.Run(); err != nil {
		return nil, fmt.Errorf("read committed application artifacts: %w", err)
	}
	return output.Bytes(), nil
}
