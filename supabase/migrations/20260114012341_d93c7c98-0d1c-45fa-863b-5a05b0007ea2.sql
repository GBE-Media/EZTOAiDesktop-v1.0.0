-- Add group_id and group_label columns to product_measurements for grouping takeoff sessions
ALTER TABLE product_measurements
ADD COLUMN group_id uuid DEFAULT NULL,
ADD COLUMN group_label text DEFAULT '';

-- Add index for efficient group queries
CREATE INDEX idx_product_measurements_group_id ON product_measurements(group_id);