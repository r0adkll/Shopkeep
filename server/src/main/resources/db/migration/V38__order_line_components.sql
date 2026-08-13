-- Design/variant identity behind a matched order line (D20). Resolution
-- flattens designs/variants into material selections; the recognizable
-- names are kept here so order cards can show the colorway/build matched.
ALTER TABLE order_lines ADD COLUMN matched_components JSONB;
