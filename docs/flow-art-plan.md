# Flow art plan (icons and images)

All images: Google Flow, image model (Nano Banana), 0 credits per image. One shared style so every picture
matches the site's 3D scenes (node field, fee flow, Merkle tree).

**Style anchor (appended to every prompt):**
> Architectural maquette photographed at night: matte graphite clay objects with crisp hairline edges, on a
> seamless near-black background (#0c0c0c), one vivid green light (#00C805) used only as a small accent,
> soft top-left key light, gentle falloff into darkness, subtle film grain, studio product photography,
> three-quarter isometric view, minimal, no text, no letters, no numbers, no logos, no people, no robots,
> no neon, no rainbow.

## Feature icons (1:1, used in the "What the MVP includes" bento)
| File | Subject |
| --- | --- |
| `fee-funded.webp` | Small green-lit cubes rolling off a curved graphite ramp into a shallow graphite tray |
| `two-node.webp` | Two identical graphite blocks joined by a thin glowing green arc, both tops faintly lit |
| `public-pot.webp` | A shallow graphite cylinder vessel, partly filled with a calm luminous green liquid, measuring marks on its rim |
| `merkle.webp` | A small tree sculpture of graphite cubes on thin rods; one path from a bottom cube to the top glows green |
| `models.webp` | Exactly two graphite cartridges resting in a tray with two slots, one empty slot greyed out |
| `no-holding.webp` | An open, empty graphite wallet-shaped tray, nothing inside, clean shadow |
| `no-allocation.webp` | A single long graphite bar pouring entirely into a curved ramp, no side container |

## Page banners (16:9, top of each dApp page, behind the title with a scrim)
| File | Page | Subject |
| --- | --- | --- |
| `banner-status.webp` | /app | A row of graphite ledger slabs, the newest one lit green at its edge |
| `banner-claim.webp` | /app/claim | A wide Merkle tree maquette, one leaf-to-root path lit green |
| `banner-jobs.webp` | /jobs | Two workstations as graphite blocks side by side, the same small cube arriving on both |
| `banner-nodes.webp` | /nodes | A single desktop GPU card as a matte graphite maquette, fans as shallow discs, one green status light |
| `banner-token.webp` | /token | A bonding-curve wall sculpture with a tiny green marker climbing it |

## Social card
| `og.webp` | 1200×630 share image: the node field from above, one green pair, empty space left for the wordmark (added in code) |

Placement: `public/art/*.webp` (converted from Flow PNG, ≤ 200 KB each), loaded with `next/image`,
`alt=""` + `aria-hidden` because they are decoration; the existing line drawings stay as the fallback.
Credit line in README: "Illustrations generated with Google Flow for this project."
