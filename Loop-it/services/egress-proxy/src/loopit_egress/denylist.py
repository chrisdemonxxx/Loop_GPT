"""Abuse-infrastructure denylist (Doc 02 §5, Doc 09 §2, P1-2).

Free compute attracts miners before it attracts users. Cryptomining is the
single highest-volume abuse of any hosted sandbox platform, and it is unusual
among abuse classes in being *cheaply detectable at the network edge*: miners
must reach a pool, and pools are a small, well-known, slow-moving set.

This list is a floor, not a defence. It is trivially evaded by a private pool or
a proxy, so it sits alongside CPU-shape detection in the abuse engine. Its value
is that it stops the overwhelming majority of opportunistic abuse for almost no
cost and produces a high-signal audit record when it fires.

Entries here are denied **unconditionally** — a project cannot allowlist its way
past them, because there is no legitimate build step that dials a mining pool.
"""

from __future__ import annotations

#: Public pool endpoints. Matched as domain suffixes.
MINING_POOL_DOMAINS: frozenset[str] = frozenset(
    {
        "nicehash.com",
        "nanopool.org",
        "ethermine.org",
        "f2pool.com",
        "antpool.com",
        "poolin.com",
        "viabtc.com",
        "slushpool.com",
        "braiins.com",
        "minexmr.com",
        "supportxmr.com",
        "moneroocean.stream",
        "hashvault.pro",
        "unmineable.com",
        "2miners.com",
        "herominers.com",
        "flexpool.io",
        "k1pool.com",
        "zergpool.com",
        "prohashing.com",
        "miningpoolhub.com",
        "dxpool.com",
        "emcd.io",
        "woolypooly.com",
        "c3pool.com",
        "xmrpool.eu",
        "crazypool.org",
    }
)

#: Substrings that are only ever present in mining infrastructure hostnames.
#:
#: Kept deliberately narrow. A broad token like "pool" or "coin" would deny
#: `pool.ntp.org` and `coinbase.com`, and a denylist that blocks legitimate
#: builds gets switched off, which is worse than one that misses a miner.
MINING_HOST_KEYWORDS: tuple[str, ...] = (
    "stratum",
    "miningpool",
    "mining-pool",
    "xmrpool",
    "moneropool",
    "ethpool",
    "cryptonight",
    "randomx",
)

#: Ports used almost exclusively by the Stratum mining protocol.
#:
#: Blocking by port catches private pools that carry no recognisable name, which
#: is the evasion the domain list cannot see.
STRATUM_PORTS: frozenset[int] = frozenset({3333, 3334, 4444, 5555, 5556, 7777, 8888, 14444, 45700})


def mining_denial(host: str, port: int | None = None) -> str | None:
    """Return a denial reason if this destination is mining infrastructure.

    Args:
        host: normalised (lowercased, trailing-dot-stripped) hostname.
        port: destination port, when known.

    Returns:
        A stable reason string for the audit record, or ``None`` if this
        destination is not recognised as mining infrastructure.
    """
    normalised = host.strip().rstrip(".").lower()

    for domain in MINING_POOL_DOMAINS:
        if normalised == domain or normalised.endswith(f".{domain}"):
            return f"mining_pool:{domain}"

    for keyword in MINING_HOST_KEYWORDS:
        if keyword in normalised:
            return f"mining_keyword:{keyword}"

    if port is not None and port in STRATUM_PORTS:
        return f"stratum_port:{port}"

    return None
