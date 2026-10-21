param(
    [string]$Image = "loopit-sandbox:dev",
    [string]$ProxyUrl = "http://egress-proxy:3128",
    [string]$Network = "loopit_sandbox_internal"
)

$ErrorActionPreference = "Stop"

$existing = docker network ls --filter "name=^$Network$" --format "{{.Name}}"
if ($existing -ne $Network) {
    docker network create --internal $Network | Out-Null
}

docker run --rm -it `
    --network $Network `
    --env "HTTP_PROXY=$ProxyUrl" `
    --env "HTTPS_PROXY=$ProxyUrl" `
    --env "ALL_PROXY=$ProxyUrl" `
    --env "NO_PROXY=127.0.0.1,localhost,::1" `
    --dns 127.0.0.11 `
    $Image
