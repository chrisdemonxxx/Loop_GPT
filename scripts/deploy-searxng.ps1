#!/usr/bin/env pwsh
# Deploy SearXNG Docker files to the red-kit/loop-search Space.
# The Space was created at https://huggingface.co/spaces/red-kit/loop-search
# but has no app files yet. This pushes the Dockerfile and settings.yml.
# Prerequisites:
#   - HF_TOKEN set in environment (read-write scope)
#   - Python huggingface_hub installed: pip install huggingface_hub
#   - Or use the `hf` CLI: hf space upload red-kit/loop-search deploy/space-searxng/
write-host 'Pushing SearXNG Space files...'
$root = 'C:/Users/chris/Desktop/Workspace/dev-projects/loop-gpt'
$src = "$root/deploy/space-searxng"
$tmp = "$env:TEMP/searxng-push"
if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp }
New-Item -ItemType Directory -Path $tmp -Force | Out-Null
Copy-Item "$src/Dockerfile" "$tmp/Dockerfile"
Copy-Item "$src/settings.yml" "$tmp/settings.yml"
Set-Location $tmp
git init
git add .
git commit -m 'Initial SearXNG Docker Space' --quiet
# Use the HF_TOKEN for auth
$token = $env:HF_TOKEN
if (-not $token) {
  write-error 'HF_TOKEN environment variable is required'
  exit 1
}
$remote = "https://user:${token}@huggingface.co/spaces/red-kit/loop-search"
git remote add origin $remote
try {
  git push origin main --force 2>&1 | Out-Null
  write-host 'SUCCESS: SearXNG Space files pushed. Building...'
  write-host 'Endpoint will be available at: https://red-kit-loop-search.hf.space'
  write-host '(Allow ~2-3 minutes for the Docker build. Check status at the Space dashboard.)'
} catch {
  write-error "Push failed. Try manually: cd $src && git init && git add . && git commit -m init && git remote add origin https://user:YOUR_TOKEN@huggingface.co/spaces/red-kit/loop-search && git push origin main --force"
}
Set-Location $root
