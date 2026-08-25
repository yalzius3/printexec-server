-- Patron 3D filament reference catalog (local Egyptian vendor, patron-3d.com).
--
-- Adds 75 global filament references across the four families Patron sells:
--   PLA+        43 colors   density 1.24
--   PLA Matte   14 colors   density 1.31
--   PLA Marble   4 colors   density 1.24, pattern = marble
--   PETG HS     14 colors   density 1.26, hotter nozzle + bed
--
-- The technical profile is generalized per family: every spool inside a family
-- shares the vendor datasheet values and differs only in color / hex / clarity.
--
-- Convention note: filament_reference.melting_temp holds the NOZZLE temperature
-- (existing rows: PLA Matte 210, PETG 240), not the polymer melt point, and the
-- API enforces melting_temp BETWEEN extruder_temp_range. Patron's datasheet
-- melt point (160 C for the PLA families) is therefore recorded in notes.
--
-- Idempotent: re-running inserts nothing. Dedupe key matches the API's own
-- check (brand, material_type, color, diameter), case-insensitive.

BEGIN;

CREATE TEMP TABLE patron_filament_seed (
  material_type text    NOT NULL,
  color         text    NOT NULL,
  hex           text    NOT NULL,
  translucent   boolean NOT NULL,
  finish        text,
  pattern       text,
  density       numeric NOT NULL,
  melting_temp  int     NOT NULL,
  ext_min       int     NOT NULL,
  ext_max       int     NOT NULL,
  bed_temp      int     NOT NULL,
  bed_min       int     NOT NULL,
  bed_max       int     NOT NULL,
  max_speed     int     NOT NULL,
  description   text,
  notes         text
) ON COMMIT DROP;

-- ── PLA+ ──────────────────────────────────────────────────────────────────────
-- Nozzle 190-230 C | bed 60 C | < 300 mm/s | density 1.24 g/cm3
INSERT INTO patron_filament_seed
SELECT 'PLA+', c.color, c.hex, c.translucent,
       'glossy', NULL, 1.24, 210, 190, 230, 60, 55, 65, 300,
       'Eco-friendly PLA+ that prints easily with a smooth surface finish. Good toughness and strong impact resistance for functional parts, modelling and rapid prototyping.',
       'Patron 3D datasheet: melt point 160 C, Vicat softening 60 C, heat deflection 60 C, melt index 42.4 +/- 3.5 g/10 min. Dry 50 C for 8 h; store below 20% RH sealed with desiccant. Sold in 1 kg and 3 kg spools.'
FROM (VALUES
  ('Baby Blue',        'A8D8F0', false),
  ('Beige',            'E8DCC0', false),
  ('Black',            '1A1A1A', false),
  ('Blue',             '1D4ED8', false),
  ('Bone White',       'E3DAC9', false),
  ('Brick',            'A24A34', false),
  ('Bronze',           'CD7F32', false),
  ('Brown',            '6F4522', false),
  ('Burgundy',         '7B1B2E', false),
  ('Canary Yellow',    'FFE93B', false),
  ('Clear',            'E6EDF0', true ),
  ('Cold White',       'F2F6F8', false),
  ('Cyan',             '00B8D4', false),
  ('Dark Blue',        '16305F', false),
  ('Dark Brown',       '3E2617', false),
  ('Fire Engine Red',  'CE2029', false),
  ('Gold',             'D4AF37', false),
  ('Green',            '2E9E4F', false),
  ('Grey',             '8A8F94', false),
  ('Light Khaki',      'CFC094', false),
  ('Light Pink',       'F7C6D9', false),
  ('Light Turquoise',  '84DCCF', false),
  ('Lilac',            'C8A2C8', false),
  ('Milky White',      'F8F4EA', false),
  ('Mint Green',       '9BE0C2', false),
  ('Mustard Yellow',   'D8A31A', false),
  ('Neon Pink',        'FF3E9A', false),
  ('Oil Green',        '4C5A34', false),
  ('Olive Green',      '6E7A32', false),
  ('Orange',           'F26F21', false),
  ('Peak Green',       '0FA36B', false),
  ('Pink',             'EE6BA8', false),
  ('Purple',           '7B3FC4', false),
  ('Red',              'CE2233', false),
  ('Royal Gold',       'C9A227', false),
  ('Sand Brown',       'C89F6E', false),
  ('Silver',           'C0C4C8', false),
  ('Sky Blue',         '4FB0E8', false),
  ('Solid Red',        'C1272D', false),
  ('Space Grey',       '4A4E54', false),
  ('Violet',           '6246C8', false),
  ('White',            'F7F9FA', false),
  ('Yellow',           'F7CC1B', false)
) AS c(color, hex, translucent);

-- ── PLA Matte ─────────────────────────────────────────────────────────────────
-- Same thermals as PLA+, denser filler (1.31) for the matte surface.
INSERT INTO patron_filament_seed
SELECT 'PLA Matte', c.color, c.hex, false,
       'matte', NULL, 1.31, 210, 190, 230, 60, 55, 65, 300,
       'Matte PLA with a smooth, fine-grained finish that significantly reduces visible layer lines. Suited to design projects, architectural models and display pieces.',
       'Patron 3D datasheet: melt point 160 C, Vicat softening 60 C, heat deflection 60 C. Diameter tolerance +/- 0.03 mm. Dry 50 C for 8 h; store below 20% RH sealed with desiccant.'
FROM (VALUES
  ('Black',            '202020'),
  ('Chocolate Brown',  '4B3227'),
  ('Emerald Green',    '1E8A5F'),
  ('Fire Red',         'D12B22'),
  ('Flamingo Pink',    'F58FA8'),
  ('Flamingo Red',     'E1564C'),
  ('Ivory',            'F2EADA'),
  ('Light Blue',       'AACFE8'),
  ('Light Gray',       'C2C6C9'),
  ('Navy Blue',        '1E3050'),
  ('Off White',        'EFEDE6'),
  ('Olive Green',      '6E7A32'),
  ('Plum',             '7A3F68'),
  ('Yellow',           'EFC53F')
) AS c(color, hex);

-- ── PLA Marble ────────────────────────────────────────────────────────────────
-- PLA+ base with a stone-look particle fill.
INSERT INTO patron_filament_seed
SELECT 'PLA Marble', c.color, c.hex, false,
       'glossy', 'marble', 1.24, 210, 190, 230, 60, 55, 65, 300,
       'Eco-friendly marble-effect PLA+ with a stone-look surface. Balances strength, rigidity and toughness for decorative and functional parts.',
       'Patron 3D datasheet: melt point 160 C, Vicat softening 60 C, heat deflection 60 C, melt index 42.4 +/- 3.5 g/10 min. Dry 50 C for 8 h; store below 20% RH sealed with desiccant.'
FROM (VALUES
  ('Baby Blue',        'AFCBDD'),
  ('Mocha',            '8A6F5D'),
  ('Turquoise',        '74B3AB'),
  ('White',            'E9E6DF')
) AS c(color, hex);

-- ── PETG HS ───────────────────────────────────────────────────────────────────
-- High-speed PETG: nozzle 220-260 C, bed 75-90 C, 40-300 mm/s, density 1.26.
INSERT INTO patron_filament_seed
SELECT 'PETG HS', c.color, c.hex, c.translucent,
       'matte', NULL, 1.26, 240, 220, 260, 80, 75, 90, 300,
       'High-speed PETG engineered to print up to twice as fast as standard PETG with less oozing and clumping. Stronger and more durable than PLA, with a matte finish that evens out gloss.',
       'Patron 3D datasheet: heat deflection 69 C at 0.45 MPa, 100% fan, heated bed required. Preset print speed 258 mm/s. Dry 60 C for 8 h before printing.'
FROM (VALUES
  ('Black',            '1A1A1A', false),
  ('Blue',             '1D4ED8', false),
  ('Brown',            '6F4522', false),
  ('Clear',            'E6EDF0', true ),
  ('Gold',             'D4AF37', false),
  ('Grey',             '8A8F94', false),
  ('Orange',           'F26F21', false),
  ('Peak Green',       '0FA36B', false),
  ('Red',              'CE2233', false),
  ('Silver',           'C0C4C8', false),
  ('Skin',             'E7B894', false),
  ('Violet',           '6246C8', false),
  ('White',            'F7F9FA', false),
  ('Yellow',           'F7CC1B', false)
) AS c(color, hex, translucent);

-- ── Insert into the live catalog ──────────────────────────────────────────────
-- bed_temp_range / extruder_temp_range are written through a type probe: the
-- service layer sends native arrays while the older seed script sent JSON, so
-- the column type is resolved here rather than assumed.
DO $seed$
DECLARE
  v_source_type  text := 'external';  -- vendor-published catalog, not tenant-authored
  v_col_type     text;
  v_bed_expr     text;
  v_ext_expr     text;
  v_inserted     int;
BEGIN
  SELECT format_type(atttypid, atttypmod)
    INTO v_col_type
    FROM pg_attribute
   WHERE attrelid = 'filament_reference'::regclass
     AND attname  = 'bed_temp_range'
     AND NOT attisdropped;

  IF v_col_type IS NULL THEN
    RAISE EXCEPTION 'filament_reference.bed_temp_range column not found';
  END IF;

  IF v_col_type LIKE '%[]' THEN
    v_bed_expr := format('ARRAY[s.bed_min, s.bed_max]::%s', v_col_type);
    v_ext_expr := format('ARRAY[s.ext_min, s.ext_max]::%s', v_col_type);
  ELSIF v_col_type IN ('json', 'jsonb') THEN
    v_bed_expr := format('to_jsonb(ARRAY[s.bed_min, s.bed_max])::%s', v_col_type);
    v_ext_expr := format('to_jsonb(ARRAY[s.ext_min, s.ext_max])::%s', v_col_type);
  ELSE
    RAISE EXCEPTION 'Unsupported bed_temp_range column type: %', v_col_type;
  END IF;

  EXECUTE format($sql$
    INSERT INTO filament_reference (
      company_id, created_by_company_id, source_type,
      brand, material_type, color, diameter,
      melting_temp, max_print_speed_mm_s, hex, density,
      bed_temp, bed_temp_range, extruder_temp_range,
      finish, fill, pattern, multi_color_direction,
      translucent, glow, description, notes
    )
    SELECT
      NULL, NULL, %L,
      'Patron 3D', s.material_type, s.color, 1.75,
      s.melting_temp, s.max_speed, s.hex, s.density,
      s.bed_temp, %s, %s,
      s.finish, NULL, s.pattern, NULL,
      s.translucent, false, s.description, s.notes
    FROM patron_filament_seed s
    WHERE NOT EXISTS (
      SELECT 1
        FROM filament_reference fr
       WHERE lower(fr.brand)         = lower('Patron 3D')
         AND lower(fr.material_type) = lower(s.material_type)
         AND lower(fr.color)         = lower(s.color)
         AND fr.diameter             = 1.75
    )
  $sql$, v_source_type, v_bed_expr, v_ext_expr);

  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  RAISE NOTICE 'Patron 3D catalog: % reference(s) inserted (range column type: %).',
    v_inserted, v_col_type;
END
$seed$;

COMMIT;

-- Verify:
--   SELECT material_type, count(*), min(density), min(melting_temp)
--     FROM filament_reference WHERE brand = 'Patron 3D'
--    GROUP BY material_type ORDER BY material_type;
-- Expected: PETG HS 14 | PLA Marble 4 | PLA Matte 14 | PLA+ 43  (75 total)
