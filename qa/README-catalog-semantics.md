# Catalog semantic QA invariants

Catalog is a commercial portfolio, not a raw Amazon record browser.

The production browser QA enforces these invariants for every rendered Catalog capture:

- Structural parents never leak into the sellable child member list.
- A family with sellable children is never diagnosed as `STRUCTURAL_PARENT`.
- Family sales, units, sessions, available and inbound inventory equal the sum of sellable children.
- Family conversion is recomputed as total child units / total child sessions, never averaged from child percentages.
- All families are collapsed by default so the landing state remains a comparative portfolio report rather than a SKU wall.
- Multidimensional seller taxonomy is exposed separately from Amazon parent/child identity and can support arbitrary dimensions such as design and ruling.

Visual success alone is not acceptance. The rendered production screen must still be compared against GitHub issue #14 for hierarchy, density, business-question fit and sellable product quality.
