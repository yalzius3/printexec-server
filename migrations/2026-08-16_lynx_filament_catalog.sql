-- LynX Additive Manufacturing filament reference catalog (local Egyptian vendor,
-- lynx-am.com, Cairo).
--
-- Adds 52 global filament references across the seven families LynX sells:
--   PLA+       31 colors   density 1.21    nozzle 210-245  bed 60-65
--   PETG HF     8 colors   density 1.29    nozzle 235-265  bed 80-90
--   PLA-CF      9 colors   density 1.24 *  nozzle 230-250  bed 65-70   carbon fiber
--   PETG-CF     1 color    density 1.17    nozzle 240-280  bed 80-90   carbon fiber
--   ABS-CF      1 color    density 1.08 *  nozzle 265-290  bed 100-110 * carbon fiber
--   ABS+        1 color    density 1.05    nozzle 240-275  bed 100-110
--   ASA         1 color    density 1.025   nozzle 245-275  bed 100-110
--
-- Same shape as 2026-07-22_patron_filament_catalog.sql: one generalized technical
-- profile per family, colors differ only in name / hex / clarity.
--
-- ── Where the numbers come from ───────────────────────────────────────────────
-- Primary source is the vendor's own versioned Technical Data Sheets, published at
-- lynx-am.com/general-5:
--   TDS PLA+      V2.2  13/11/2024
--   TDS PETG-HF   V1.0  04/01/2025
--   TDS ABS       V1.0  07/11/2024
--   TDS ASA       V1.0  07/11/2024
--   TDS PETG-CF20 V1.0  05/11/2024
-- The per-product "Print Settings" blocks on the shop listings disagree slightly
-- with the TDS (vendor copy-paste drift: PLA+ listings variously say 205-235 or
-- 210-230 against the datasheet's 210-245). The dated, versioned TDS wins; the
-- listing values are not recorded.
--
-- LynX also publishes a TDS for plain PETG (density 1.20, nozzle 235-280) but
-- currently sells no PETG SKUs -- only PETG HF -- so no rows are seeded for it.
--
-- Derived values, all stated rather than silently assumed:
--   * melting_temp = midpoint of the TDS printing-temp range, rounded DOWN to the
--     nearest 5 C. Convention note (same trap as the Patron catalog):
--     filament_reference.melting_temp holds the NOZZLE temperature, not the polymer
--     melt point, and the API enforces melting_temp BETWEEN extruder_temp_range.
--     The datasheet melt points (PLA+ 150 C, PETG-HF 200 C, PETG-CF20 210 C) are
--     therefore recorded in notes.
--   * bed_temp = midpoint of the TDS bed range, rounded DOWN to the nearest 5 C.
--   * PETG HF max_print_speed_mm_s: the vendor quotes a VOLUMETRIC ceiling only
--     (18-21 mm3/s), never mm/s. 250 mm/s is that 21 mm3/s ceiling at the stock
--     0.4 mm nozzle / 0.2 mm layer (0.42 x 0.2 = 0.084 mm2 -> 21 / 0.084 = 250).
--     Recomputed if you run a different nozzle.
--   * PLA-CF and ABS-CF have NO datasheet -- the only vendor data is the shop
--     listing's Print Settings block. Their density (and ABS-CF's bed range and
--     speed, which the listing omits entirely) are class estimates, flagged in
--     each row's notes. Marked with * above.
--
-- ── Hex values ────────────────────────────────────────────────────────────────
-- PLA-CF is sold as one product with a real color-swatch picker, so those nine
-- hex codes are the vendor's OWN published values, copied exactly. Likewise the
-- single-color swatches on PETG-CF, ABS+ and ASA (all #000000).
--
-- Every PLA+ and PETG HF color is a separate product with no swatch and no RAL
-- code in the markup, so those hex values are APPROXIMATIONS -- as with Patron,
-- they only drive UI color chips and are safe to tweak. Four are better than
-- guesses: the vendor's own URL slugs leak RAL names that the display names hide
-- (blue-lilac = RAL 4005, yellow-green = RAL 6018, traffic-green = RAL 6024,
-- traffic-purple = RAL 4006), so those use the RAL values.
--
-- Sampling the product photos was tried and rejected: the spool body dominates
-- the frame, so Traffic Purple and Traffic Green both sampled out grey.
--
-- `finish` is inferred from material class (CF families matte, PLA+/PETG/ABS
-- glossy) EXCEPT PETG-CF, whose TDS states matte outright. `translucent` is set
-- only where the vendor's own color name says so (Clear PETG HF).
--
-- Idempotent: re-running inserts nothing. Dedupe key matches the API's own check
-- (brand, material_type, color, diameter), case-insensitive.

BEGIN;

CREATE TEMP TABLE lynx_filament_seed (
  material_type text    NOT NULL,
  color         text    NOT NULL,
  hex           text    NOT NULL,
  translucent   boolean NOT NULL,
  finish        text,
  fill          text,
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
-- TDS PLA+ V2.2: nozzle 210-245 C | bed 60-65 C | 40-200 mm/s | 1.2-1.22 g/cm3
INSERT INTO lynx_filament_seed
SELECT 'PLA+', c.color, c.hex, false,
       'glossy', NULL, 1.21, 225, 210, 245, 60, 60, 65, 200,
       'Industrial-grade PLA+ compound reformulated for FDM, with enhanced mechanical properties, toughness and printability. The vendor''s widest range, offered in more than 25 colors.',
       'LynX TDS PLA+ V2.2 (13/11/2024): melt point 150 C +/-5, heat deflection 53.4 C, tensile 61 MPa, elongation at break 5.3%, flexural modulus 1824 N/mm2, impact 12.4 kJ/m2. First layer 215-245 C, cooling 50-100%, volumetric max 16 mm3/s. Diameter tolerance +/-0.05 mm. 1 kg spools; some colors also sold in 2.5 kg.'
FROM (VALUES
  ('Black',           '1A1A1A'),
  ('Blue',            '1D4ED8'),
  ('Bone White',      'E3DAC9'),
  ('Brown',           '6B4526'),
  ('Cold White',      'F2F6F8'),
  ('Coral Red',       'D93A2B'),
  ('Creamy Beige',    'EDDFC4'),
  ('Dark Grey',       '585C60'),
  ('Gold',            'D4AF37'),
  ('Greige',          'B7ADA1'),
  ('Jungle Green',    '57A639'),  -- slug yellow-green = RAL 6018
  ('Light Brown',     'A9784E'),
  ('Light Grey',      'C2C6C9'),
  ('Mint Green',      '9BE0C2'),
  ('Natural',         'E8E2D5'),
  ('Off White',       'EFEDE6'),
  ('Orange',          'F26F21'),
  ('Orange Brown',    'B85C22'),
  ('Pearl White',     'F0EEE9'),
  ('Pepsi Blue',      '004B93'),
  ('Pink',            'EE6BA8'),
  ('Purple',          '7B3FC4'),
  ('Purple Haze',     '6C6DA4'),  -- slug blue-lilac = RAL 4005
  ('Silver',          'C0C4C8'),
  ('Skin',            'E7B894'),
  ('Sky Blue',        '4FB0E8'),
  ('Traffic Green',   '308446'),  -- RAL 6024
  ('Traffic Purple',  '8E3A80'),  -- RAL 4006
  ('Turquoise',       '2FB3A8'),
  ('White',           'F7F9FA'),
  ('Yellow',          'F7CC1B')
) AS c(color, hex);

-- ── PETG HF ───────────────────────────────────────────────────────────────────
-- TDS PETG-HF V1.0: nozzle 235-265 C | bed 80-90 C | 18-21 mm3/s | 1.29 g/cm3
INSERT INTO lynx_filament_seed
SELECT 'PETG HF', c.color, c.hex, c.translucent,
       'glossy', NULL, 1.29, 250, 235, 265, 85, 80, 90, 250,
       'Toughness-modified PETG engineered for high-speed printing. Flows faster than standard PETG while holding layer bonding, with better mechanical strength and heat resistance -- suited to functional and end-use parts.',
       'LynX TDS PETG-HF V1.0 (04/01/2025): melt point 200 C +/-5, heat deflection 80 C, tensile 54 MPa, elongation at break 15%, flexural modulus 2145 N/mm2, impact 5.6 kJ/m2, MFR 2-3 g/10 min. First layer 240-250 C, PEI textured bed, cooling 0-50%, flow ratio 0.95-0.96. Diameter tolerance +/-0.03 mm. Dry 60 C for 6 h. Speed ceiling is volumetric (18-21 mm3/s); the 250 mm/s figure is that ceiling at a 0.4 mm nozzle / 0.2 mm layer.'
FROM (VALUES
  ('Black',   '1A1A1A', false),
  ('Blue',    '1D4ED8', false),
  ('Clear',   'E6EDF0', true ),
  ('Green',   '2E9E4F', false),
  ('Red',     'CE2233', false),
  ('Silver',  'C0C4C8', false),
  ('White',   'F7F9FA', false),
  ('Yellow',  'F7CC1B', false)
) AS c(color, hex, translucent);

-- ── PLA-CF ────────────────────────────────────────────────────────────────────
-- No TDS published. Values from the shop listing's Print Settings block:
-- nozzle 230-250 C | bed 65-70 C | 180 mm/s (or 15 mm3/s) | cooling 100%.
-- Hex values below are the vendor's OWN swatch codes, copied exactly.
INSERT INTO lynx_filament_seed
SELECT 'PLA-CF', c.color, c.hex, false,
       'matte', 'carbon fiber', 1.24, 240, 230, 250, 65, 65, 70, 180,
       'Premium PLA reinforced with optimized carbon fiber content for markedly higher stiffness and a refined surface finish. The carbon-infused structure reduces visible layer lines, so parts come off the printer closer to finished.',
       'LynX publishes no TDS for PLA-CF; figures are from the shop listing. First layer 230-250 C, cooling 100%, 180 mm/s or 15 mm3/s. HARDENED STEEL NOZZLE REQUIRED. Vendor warns to keep the printer well ventilated to prevent clogs and to purge with PLA or PETG after use. Density 1.24 is a CLASS ESTIMATE (PLA+ base 1.2-1.22 plus CF loading), not a vendor figure.'
FROM (VALUES
  ('Carbon Black',  '000000'),
  ('Carbon Olive',  '377B2B'),
  ('Cement',        'C2CEC1'),
  ('Dark Grey',     '74787D'),
  ('Eclipse',       '311C17'),
  ('Iron Green',    '406D4C'),
  ('Khaki Brown',   '75623A'),
  ('Navy Blue',     '33739E'),
  ('Timber Brown',  'AA7A31')
) AS c(color, hex);

-- ── PETG-CF ───────────────────────────────────────────────────────────────────
-- TDS PETG-CF20 V1.0: nozzle 240-280 C | bed 80-90 C | 30-100 mm/s | 1.17 g/cm3
INSERT INTO lynx_filament_seed
SELECT 'PETG-CF', 'Black', '000000', false,
       'matte', 'carbon fiber', 1.17, 260, 240, 280, 85, 80, 90, 100,
       'PETG compounded with short carbon fibers for higher stiffness, strength and dimensional stability while keeping PETG''s flexibility and easy printing. The fiber load gives a matte, lightly textured surface.',
       'LynX TDS PETG-CF20 V1.0 (05/11/2024): melt point 210 C +/-5, heat deflection 85 C, Vicat softening 105 C, tensile 41 MPa, elongation at break 5.6%, flexural modulus 1973 N/mm2, impact 28 kJ/m2. First layer 250-270 C, cooling 0-30%. Diameter tolerance +/-0.05 mm. Dry 55-60 C for 6 h. VENDOR RECOMMENDS A 0.6 mm HARDENED NOZZLE because of the 20% CF content. Sold as PETG-CF20 in 500 g and 1 kg.';

-- ── ABS-CF ────────────────────────────────────────────────────────────────────
-- No TDS published. The shop listing states ONLY the print temperature.
INSERT INTO lynx_filament_seed
SELECT 'ABS-CF', 'Black', '000000', false,
       'matte', 'carbon fiber', 1.08, 275, 265, 290, 105, 100, 110, 150,
       'ABS reinforced with carbon fiber for high strength, rigidity and improved thermal resistance. The formulation improves dimensional stability and cuts the warping and shrinkage that plague plain ABS, with a smooth low-layer-line finish for automotive, tooling and industrial parts.',
       'LynX publishes no TDS for ABS-CF. The shop listing states ONLY "Print Temp: 265-290 C" -- everything else here is inferred and should be confirmed with the vendor: density 1.08 is a class estimate, and the bed range (100-110 C), speed (150 mm/s) and enclosure requirement are carried over from LynX ABS+. Hardened nozzle required. Color is not selectable on the listing; black assumed.';

-- ── ABS+ ──────────────────────────────────────────────────────────────────────
-- TDS ABS V1.0: nozzle 240-275 C | bed 100-110 C | 30-150 mm/s | 1.05 g/cm3
INSERT INTO lynx_filament_seed
SELECT 'ABS+', 'Black', '000000', false,
       'glossy', NULL, 1.05, 255, 240, 275, 105, 100, 110, 150,
       'Versatile ABS with strong mechanical performance, high impact resistance and easy post-processing (sanding, acetone smoothing, gluing). Balanced toughness and rigidity for engineering and industrial parts.',
       'LynX TDS ABS V1.0 (07/11/2024): heat deflection 82 C, Vicat softening 102 C, tensile 45 MPa, elongation at break 24%, flexural modulus 2248 N/mm2, impact 38 kJ/m2. First layer 250-260 C, PEI textured bed, cooling 0%. Diameter tolerance +/-0.05 mm. Dry 55-60 C for 8 h. ENCLOSED CHAMBER RECOMMENDED. Sold in 500 g and 1 kg.';

-- ── ASA ───────────────────────────────────────────────────────────────────────
-- TDS ASA V1.0: nozzle 245-275 C | bed 100-110 C | 30-150 mm/s | 1.02-1.03 g/cm3
INSERT INTO lynx_filament_seed
SELECT 'ASA', 'Black', '000000', false,
       'matte', NULL, 1.025, 260, 245, 275, 105, 100, 110, 150,
       'Engineering-grade ASA with superior UV resistance, weatherability and thermal stability for outdoor and industrial parts. Matches ABS on strength and impact resistance with better environmental durability and less tendency to warp.',
       'LynX TDS ASA V1.0 (07/11/2024): heat deflection 87 C, tensile 46 MPa, elongation at break 27%, flexural modulus 2548 N/mm2, impact 17.6 kJ/m2. First layer 250-270 C, PEI textured or smooth bed, cooling 0-20%. Diameter tolerance +/-0.05 mm. Dry 60 C for 6 h. ENCLOSED CHAMBER RECOMMENDED. Listing reports up to 250 mm/s tested (300 mm/s at 270 C) against the datasheet''s 150 mm/s ceiling; the datasheet value is used. Sold in 500 g and 1 kg.';

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
      'LynX', s.material_type, s.color, 1.75,
      s.melting_temp, s.max_speed, s.hex, s.density,
      s.bed_temp, %s, %s,
      s.finish, s.fill, NULL, NULL,
      s.translucent, false, s.description, s.notes
    FROM lynx_filament_seed s
    WHERE NOT EXISTS (
      SELECT 1
        FROM filament_reference fr
       WHERE lower(fr.brand)         = lower('LynX')
         AND lower(fr.material_type) = lower(s.material_type)
         AND lower(fr.color)         = lower(s.color)
         AND fr.diameter             = 1.75
    )
  $sql$, v_source_type, v_bed_expr, v_ext_expr);

  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  RAISE NOTICE 'LynX catalog: % reference(s) inserted (range column type: %).',
    v_inserted, v_col_type;
END
$seed$;

COMMIT;

-- Verify:
--   SELECT material_type, count(*), min(density), min(melting_temp)
--     FROM filament_reference WHERE brand = 'LynX'
--    GROUP BY material_type ORDER BY material_type;
-- Expected: ABS+ 1 | ABS-CF 1 | ASA 1 | PETG HF 8 | PETG-CF 1 | PLA+ 31 | PLA-CF 9  (52 total)
