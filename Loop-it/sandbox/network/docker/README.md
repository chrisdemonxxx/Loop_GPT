# Docker provider network mode

Docker mode is for development fidelity, not the production security boundary.
The real boundary is the provider firewall plus the microVM nftables policy in
`../nftables/sandbox.nft`.

Use `docker-compose.sandbox-network.yml` or `run-sandbox-dev.ps1` to place a
sandbox container on an `internal: true` Docker network and pin
`HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY` to the egress proxy. `NO_PROXY` contains
only loopback names so sandbox code cannot opt out for cloud metadata or private
fabric.

Host-level iptables/nftables still matter in Docker mode:

- deny container bridge egress except to the egress proxy uplink;
- drop `169.254.0.0/16`, `fd00:ec2::/32`, `fe80::/10`, RFC1918, and
  carrier-grade NAT ranges before NAT;
- do not publish sandbox ports directly; use the preview proxy path instead.
