# StreamerAI design system — inspired by Runway

## 0. Product-specific direction

StreamerAI applies the cinematic restraint described below to a conversational
discovery product. The interface is not a Netflix clone and not a generic chat
window: natural-language intent begins the experience, while validated film and
series artwork remains the dominant visual output.

The visual hierarchy is fixed:

1. centered conversational search/composer;
2. populated Home rails when no conversation result is active;
3. one large colorful Best match tile for active discovery;
4. smaller colorful Available to stream tiles;
5. grayscale Found, not currently available tiles;
6. restrained conversation history and provider diagnostics.

Validated poster/backdrop artwork remains the dominant source of color.
Grayscale is a semantic availability state, not decoration, and must always be
paired with text. Cinematic keeps black, white and cool-gray chrome with the
existing red brand/actions. Automatic and pinned seasonal themes also use the
restrained environmental treatment below. These product-specific rules take
precedence over the monochrome and no-gradient reference guidance later in this
document.

### Adaptive environmental treatment

Automatic seasonal composition is the default appearance. The compact control
offers Seasonal and Cinematic; detailed Settings and onboarding expose season,
weather and lighting choices. Compose a dark seasonal base, current optional
weather and local day/night; pinning an axis changes only that axis. Manual
weather and day/night choices work without location access. Fix current
appearance pins all three resolved axes; Use automatic settings restores them.
Use muted green and blossom for spring, amber for summer, copper/burgundy for
autumn, blue-gray for winter, green/red/gold for Christmas, and navy/violet/gold for
New Year's Eve. Seasons follow the selected zone's calendar and reverse for a
configured southern-hemisphere location. Christmas covers December 20–30 and
New Year's Eve December 31–January 1, taking precedence over seasons.

Soft background glows and blurred petals, leaves, light or crystals support the
seasonal bases. Christmas has colorful lights and decorative falling snow;
New Year's Eve has soft fireworks bursts and decorative falling snow. These
festive effects are intentional regardless of actual weather; they never change
the forecast condition or imply that snowfall was measured. This explicit
fireworks treatment supersedes the earlier no-fireworks direction. Rain uses
glass impacts, refractive beads and slow sliding trails. Storm increases their
intensity and introduces irregular, diffuse background lightning with a smooth
rise/decay and a quiet interval between events. Avoid strobing. Snowflakes land
and linger on the glass, gradually creating bounded edge frost; ordinary seasonal
snow follows the weather choice. Fog lowers decorative density. Share the
animation budget between festive and weather effects and keep all effects below
controls, dialogs, cards and playback. Static treatments retain glass/frost
details without lightning.

Theme tokens cover page and surface colors, borders, primary/secondary text,
accent and focus. Retain dark readable surfaces during daytime. Keep error,
warning, success, availability and poster treatments independent of the theme.
Apply the same tokens to onboarding, profile medallions and the profile chooser.
Cinematic preserves the previous palette and renders no new ambient layer.

The ambient renderer uses one pointer-transparent, accessibility-hidden Canvas
2D layer with cached sprites and bounded weather/festive pools. Ordinary
decoration starts at 40 desktop or 16 compact-screen particles; denser glass and
festive combinations use explicit caps. Device pixel ratio is capped at 1.5 and
rendering at 30 frames per second.
Reduced motion or disabled Ambient motion retains static atmosphere and colors;
hidden pages, active playback and sustained slow frames stop animation work.
Crossfade palette changes over about one second; reduced motion changes them
immediately. Review contrast and layering at desktop and 320 px widths before
acceptance.

## 1. Visual Theme & Atmosphere

Runway's interface is a cinematic reel brought to life as a website — a dark, editorial, film-production-grade design where full-bleed photography and video ARE the primary UI elements. This is not a typical tech product page; it's a visual manifesto for AI-powered creativity. Every section feels like a frame from a film: dramatic lighting, sweeping landscapes, and intimate human moments captured in high-quality imagery that dominates the viewport.

The design language is built on a single typeface — abcNormal — a clean, geometric sans-serif that handles everything from 48px display headlines to 11px uppercase labels. This single-font commitment creates an extreme typographic uniformity that lets the visual content speak louder than the text. Headlines use tight line-heights (1.0) with negative letter-spacing (-0.9px to -1.2px), creating compressed text blocks that feel like film titles rather than marketing copy.

What makes Runway distinctive is its complete commitment to visual content as design. Rather than illustrating features with icons or diagrams, Runway shows actual AI-generated and AI-enhanced imagery — cars driving through cinematic landscapes, artistic portraits, architectural renders. The interface itself retreats into near-invisibility: minimal borders, zero shadows, subtle cool-gray text, and a dark palette that puts maximum focus on the photography.

**Key Characteristics:**
- Cinematic full-bleed photography and video as primary UI elements
- Single typeface system: abcNormal for everything from display to micro labels
- Dark-dominant palette with cool-toned neutrals (#767d88, #7d848e)
- Zero shadows, minimal borders — the interface is intentionally invisible
- Tight display typography (line-height 1.0) with negative tracking (-0.9px to -1.2px)
- Uppercase labels with positive letter-spacing for navigational structure
- Weight 450 (unusual intermediate) for small uppercase text — precision craft
- Editorial magazine layout with mixed-size image grids

## 2. Color Palette & Roles

### Primary
- **Runway Black** (`#000000`): The primary page background and maximum-emphasis text.
- **Deep Black** (`#030303`): A near-imperceptible variant for layered dark surfaces.
- **Dark Surface** (`#1a1a1a`): Card backgrounds and elevated dark containers.
- **Pure White** (`#ffffff`): Primary text on dark surfaces and light-section backgrounds.

### Surface & Background
- **Near White** (`#fefefe`): The lightest surface — barely distinguishable from pure white.
- **Cool Cloud** (`#e9ecf2`): Light section backgrounds with a cool blue-gray tint.
- **Border Dark** (`#27272a`): The single dark-mode border color — barely visible containment.

### Neutrals & Text
- **Charcoal** (`#404040`): Primary body text on light surfaces and secondary text.
- **Near Charcoal** (`#3f3f3f`): Slightly lighter variant for dark-section secondary text.
- **Cool Slate** (`#767d88`): Secondary body text — a distinctly blue-gray cool neutral.
- **Mid Slate** (`#7d848e`): Tertiary text, metadata descriptions.
- **Muted Gray** (`#a7a7a7`): De-emphasized content, timestamps.
- **Cool Silver** (`#c9ccd1`): Light borders and dividers.
- **Light Silver** (`#d0d4d4`): The lightest border/divider variant.
- **Tailwind Gray** (`#6b7280`): Standard Tailwind neutral for supplementary text.
- **Dark Link** (`#0c0c0c`): Darkest link text — nearly black.
- **Footer Gray** (`#999999`): Footer links and deeply muted content.

### Gradient System
- **None in the interface.** Visual richness comes entirely from photographic content — AI-generated and enhanced imagery provides all the color and gradient the design needs. The interface itself is intentionally colorless.

## 3. Typography Rules

### Font Family
- **Universal**: `abcNormal`, with fallback: `abcNormal Fallback`

*Note: abcNormal is a custom geometric sans-serif. For external implementations, Inter or DM Sans serve as close substitutes.*

### Hierarchy

| Role | Font | Size | Weight | Line Height | Letter Spacing | Notes |
|------|------|------|--------|-------------|----------------|-------|
| Display / Hero | abcNormal | 48px (3rem) | 400 | 1.00 (tight) | -1.2px | Maximum size, film-title presence |
| Section Heading | abcNormal | 40px (2.5rem) | 400 | 1.00–1.10 | -1px to 0px | Feature section titles |
| Sub-heading | abcNormal | 36px (2.25rem) | 400 | 1.00 (tight) | -0.9px | Secondary section markers |
| Card Title | abcNormal | 24px (1.5rem) | 400 | 1.00 (tight) | normal | Article and card headings |
| Feature Title | abcNormal | 20px (1.25rem) | 400 | 1.00 (tight) | normal | Small headings |
| Body / Button | abcNormal | 16px (1rem) | 400–600 | 1.30–1.50 | -0.16px to normal | Standard body, nav links |
| Caption / Label | abcNormal | 14px (0.88rem) | 500–600 | 1.25–1.43 | 0.35px (uppercase) | Metadata, section labels |
| Small | abcNormal | 13px (0.81rem) | 400 | 1.30 (tight) | -0.16px to -0.26px | Compact descriptions |
| Micro / Tag | abcNormal | 11px (0.69rem) | 450 | 1.30 (tight) | normal | Uppercase tags, tiny labels |

### Principles
- **One typeface, complete expression**: abcNormal handles every text role. The design achieves variety through size, weight, case, and letter-spacing rather than font-family switching.
- **Tight everywhere**: Nearly every size uses line-height 1.0–1.30 — even body text is relatively compressed. This creates a dense, editorial feel.
- **Weight 450 — the precision detail**: Some small uppercase labels use weight 450, an uncommon intermediate between regular (400) and medium (500). This micro-craft signals typographic sophistication.
- **Negative tracking as default**: Even body text uses -0.16px to -0.26px letter-spacing, keeping everything slightly tighter than default.
- **Uppercase as structure**: Labels at 14px and 11px use `text-transform: uppercase` with positive letter-spacing (0.35px) to create navigational signposts that contrast with the tight lowercase text.

## 4. Component Stylings

### Buttons
- Text: weight 600 at 14px abcNormal
- Background: likely transparent or dark, with minimal border
- Radius: small (4px) for button-like links
- The button design is extremely restrained — no heavy fills or borders detected
- Interactive elements blend into the editorial flow

### Cards & Containers
- Background: transparent or Dark Surface (`#1a1a1a`)
- Border: `1px solid #27272a` (dark mode) — barely visible containment
- Radius: small (4–8px) for functional elements; 16px for alert-style containers
- Shadow: zero — no shadows on any element
- Cards are primarily photographic — the image IS the card

### Navigation
- Minimal horizontal nav — transparent over hero content
- Logo: Runway wordmark in white/black
- Links: abcNormal at 16px, weight 400–600
- Hover: text shifts to white or higher opacity
- Extremely subtle — designed to not compete with visual content

### Image Treatment
- Full-bleed cinematic photography and video dominate
- AI-generated content shown at large scale as primary visual elements
- Mixed-size image grids creating editorial magazine layouts
- Dark overlays on hero images for text readability
- Product screenshots with subtle rounded corners (8px)

### Distinctive Components

**Conversational Composer**
- Wide, horizontally centered dark input near the top of Home
- Subtle Border Dark outline, no shadow, comfortable 8px radius
- 16–20px input text and muted gray example placeholder
- Expands for follow-up messages without turning the page into a chat transcript
- Shows a compact send control and accessible progress state

**Best Match Tile**
- Large cinematic backdrop or poster-led editorial composition
- Full color only when streaming availability is verified
- Minimal overlay: Best match label, title, year, source rating, reason, Play
- Alternate files and formats hidden behind a three-dot action

**Availability Tile**
- Smaller poster-first card with source rating and year always visible
- Available cards remain colorful; unavailable cards use grayscale artwork,
  reduced visual emphasis and explicit unavailable text
- StreamerAI Match and source Rating are visually and semantically distinct
- Play is the primary action only when verified; Add to Library is a consistent
  secondary action and becomes In Library after saving

**Home Content Rail**
- Section label and quiet freshness state above a cinematic horizontal row
- Continue Watching may include one thin progress indicator without turning the
  card into a dashboard widget
- Anchor navigation scrolls to rails; it does not introduce page-transition
  chrome for each category

**Library and History**
- Library uses a dense editorial poster grid with status filters
- Watch History is a quiet right-side rail on desktop, separated by one subtle
  border rather than elevation
- Mobile history becomes a full-width sheet with the same typography and no
  desktop-style squeezed sidebar

**Series Stack**
- Two or three subtly offset layers indicate seasons without heavy decoration
- Coverage text is explicit: seasons and verified episodes
- Expanded state reveals season/episode rows with color/grayscale availability
- No shadow; layering uses position, border and photographic contrast

**Cinematic Hero**
- Full-viewport image or video with text overlay
- Headline in 48px abcNormal, white on dark imagery
- The image is always cinematic quality — film-grade composition
- In the application this pattern is reserved for the validated Best match, not
  for an unverified model suggestion

**Research Article Cards**
- Photographic thumbnails with article titles
- Mixed-size grid layout (large feature + smaller supporting)
- Clean text overlay or below-image caption style

**Trust Bar**
- Company logos (leading organizations across industries)
- Clean, monochrome treatment
- Horizontal layout with generous spacing

**Mission Statement**
- "We are building AI to simulate the world through imagination, art and aesthetics"
- On a dark background with white text
- The emotional close — artistic and philosophical

## 5. Layout Principles

### Spacing System
- Base unit: 8px
- Scale: 4px, 6px, 8px, 12px, 16px, 20px, 24px, 28px, 32px, 48px, 64px, 78px
- Section vertical spacing: generous (48–78px)
- Component gaps: 16–24px

### Grid & Container
- Max container width: up to 1600px (cinema-wide)
- Hero: full-viewport, edge-to-edge
- Content sections: centered with generous margins
- Image grids: asymmetric, magazine-style mixed sizes
- Footer: full-width dark section

### Whitespace Philosophy
- **Cinema-grade breathing**: Large vertical gaps between sections create a scrolling experience that feels like watching scenes change.
- **Images replace whitespace**: Where other sites use empty space, Runway fills it with photography. The visual content IS the breathing room.
- **Editorial grid asymmetry**: The image grid uses intentionally varied sizes — large hero images paired with smaller supporting images, creating visual rhythm.

### Border Radius Scale
- Sharp (4px): Buttons, small interactive elements
- Subtle (6px): Links, small containers
- Comfortable (8px): Standard containers, image cards
- Generous (16px): Alert-style containers, featured elements

## 6. Depth & Elevation

| Level | Treatment | Use |
|-------|-----------|-----|
| Flat (Level 0) | No shadow, no border | Everything — the dominant state |
| Bordered (Level 1) | `1px solid #27272a` | Alert containers only |
| Dark Section (Level 2) | Dark bg (#000000 / #1a1a1a) with light text | Hero, features, footer |
| Light Section (Level 3) | White/Cool Cloud bg with dark text | Content sections, research |

**Shadow Philosophy**: Runway uses **zero shadows**. This is a film-production design decision — in cinema, depth comes from lighting, focus, and composition, not drop shadows. The interface mirrors this philosophy: depth is communicated through dark/light section alternation, photographic depth-of-field, and overlay transparency — never through CSS box-shadow.

## 7. Do's and Don'ts

### Do
- Use full-bleed cinematic photography as the primary visual element
- Use abcNormal for all text — maintain the single-typeface commitment
- Keep display line-heights at 1.0 with negative letter-spacing for film-title density
- Use the cool-gray neutral palette (#767d88, #7d848e) for secondary text
- Maintain zero shadows — depth comes from photography and section backgrounds
- Use uppercase with letter-spacing for navigational labels (14px, 0.35px spacing)
- Apply small border-radius (4–8px) — the design is NOT pill-shaped
- Let visual content (photos, videos) dominate — the UI should be invisible
- Use weight 450 for micro labels — the precision matters

### Don't
- Don't add decorative colors to the interface — the only color comes from photography
- Don't use heavy borders or shadows — the interface must be nearly invisible
- Don't use pill-shaped radius — Runway's geometry is subtly rounded, not circular
- Don't use bold (700+) weight — 400–600 is the full range, with 450 as a precision tool
- Don't compete with the visual content — text overlays should be minimal and restrained
- Don't use gradient backgrounds in the interface — gradients exist only in photography
- Don't use more than one typeface — abcNormal handles everything
- Don't use body line-height above 1.50 — the tight, editorial feel is core
- Don't reduce image quality — cinematic photography IS the design

## 8. Responsive Behavior

### Breakpoints
| Name | Width | Key Changes |
|------|-------|-------------|
| Mobile | <640px | Single column, stacked images, reduced hero text |
| Tablet | 640–768px | 2-column image grids begin |
| Small Desktop | 768–1024px | Standard layout |
| Desktop | 1024–1280px | Full layout, expanded hero |
| Large Desktop | 1280–1600px | Maximum cinema-width container |

### Touch Targets
- Navigation links at comfortable 16px
- Article cards serve as large touch targets
- Buttons at 14px weight 600 with adequate padding

### Collapsing Strategy
- **Navigation**: Collapses to hamburger on mobile
- **Hero**: Full-bleed maintained, text scales down
- **Image grids**: Multi-column → 2-column → single column
- **Research articles**: Feature-size cards → stacked full-width
- **Trust logos**: Horizontal scroll or reduced grid
- **Discovery results**: Best match stays first; Available and Unavailable
  sections become single-column lists without mixing their states
- **Series stacks**: Open into a full-width detail sheet on mobile

### Image Behavior
- Cinematic images scale proportionally
- Full-bleed hero maintained across all sizes
- Image grids reflow to fewer columns
- Video content maintains aspect ratio

## 9. Agent Prompt Guide

### Quick Color Reference
- Background Dark: "Runway Black (#000000)"
- Background Light: "Pure White (#ffffff)"
- Primary Text Dark: "Charcoal (#404040)"
- Secondary Text: "Cool Slate (#767d88)"
- Muted Text: "Muted Gray (#a7a7a7)"
- Light Border: "Cool Silver (#c9ccd1)"
- Dark Border: "Border Dark (#27272a)"
- Card Surface: "Dark Surface (#1a1a1a)"

### Example Component Prompts
- "Create a cinematic hero section: full-bleed dark background with a cinematic image overlay. Headline at 48px abcNormal weight 400, line-height 1.0, letter-spacing -1.2px in white. Minimal text below in Cool Slate (#767d88) at 16px."
- "Design a research article grid: one large card (50% width) with a cinematic image and 24px title, next to two smaller cards stacked. All images with 8px border-radius. Titles in white (dark bg) or Charcoal (#404040, light bg)."
- "Build a section label: 14px abcNormal weight 500, uppercase, letter-spacing 0.35px in Cool Slate (#767d88). No border, no background."
- "Create a trust bar: company logos in monochrome, horizontal layout with generous spacing. On dark background with white/gray logo treatments."
- "Design a mission statement section: Runway Black background, white text at 36px abcNormal, line-height 1.0, letter-spacing -0.9px. Centered, with generous vertical padding."

### Iteration Guide
1. Visual content first — always include cinematic photography
2. Use abcNormal for everything — specify size and weight, never change the font
3. Keep the interface invisible — no heavy borders, no shadows, no bright colors
4. Use the cool slate grays (#767d88, #7d848e) for secondary text — not warm grays
5. Uppercase labels need letter-spacing (0.35px) — never tight uppercase
6. Dark sections should be truly dark (#000000 or #1a1a1a) — no medium grays as surfaces
