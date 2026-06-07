import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { Client } from "pg";

const demoCompanyId = process.env.SEED_COMPANY_ID ?? "c0ffee00-1111-4d9a-8f8f-111111111111";

function extractArrayLiteral(sourceText, variableName) {
  const marker = `const ${variableName}: ReferenceOption[] = [`;
  const markerIndex = sourceText.indexOf(marker);

  if (markerIndex === -1) {
    throw new Error(`Could not find ${variableName} in App.tsx`);
  }

  const arrayStart = sourceText.indexOf("[", markerIndex + marker.length - 1);

  if (arrayStart === -1) {
    throw new Error(`Could not find array start for ${variableName}`);
  }

  let index = arrayStart;
  let bracketDepth = 0;
  let inString = false;
  let stringQuote = "";
  let escaped = false;

  while (index < sourceText.length) {
    const char = sourceText[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === stringQuote) {
        inString = false;
        stringQuote = "";
      }

      index += 1;
      continue;
    }

    if (char === '"' || char === "'" || char === "`") {
      inString = true;
      stringQuote = char;
      index += 1;
      continue;
    }

    if (char === "[") {
      bracketDepth += 1;
    } else if (char === "]") {
      bracketDepth -= 1;

      if (bracketDepth === 0) {
        return sourceText.slice(arrayStart, index + 1);
      }
    }

    index += 1;
  }

  throw new Error(`Could not find array end for ${variableName}`);
}

function loadReferenceCatalog() {
  const appPath = path.resolve("C:/Users/yamag/Desktop/XYZ/client/src/App.tsx");
  const sourceText = fs.readFileSync(appPath, "utf8");
  const filamentLiteral = extractArrayLiteral(sourceText, "filamentReferences");
  const printerLiteral = extractArrayLiteral(sourceText, "printerReferences");

  return {
    filamentReferences: vm.runInNewContext(`(${filamentLiteral})`),
    printerReferences: vm.runInNewContext(`(${printerLiteral})`)
  };
}

function detailValue(option, label) {
  return option.details.find((detail) => detail.label === label)?.value ?? "";
}

function parseNumberFromText(value) {
  const match = String(value ?? "").match(/-?\d+(\.\d+)?/);
  return match ? Number(match[0]) : null;
}

function parseRange(value) {
  const matches = String(value ?? "").match(/-?\d+(\.\d+)?/g) ?? [];
  const numbers = matches.map((entry) => Number(entry)).filter(Number.isFinite);
  return numbers.length >= 2 ? [numbers[0], numbers[1]] : null;
}

function parseBoolean(value) {
  if (value === "True") {
    return true;
  }

  if (value === "False") {
    return false;
  }

  return null;
}

function normalizeNullableText(value) {
  const normalized = String(value ?? "").trim();

  if (!normalized || normalized === "None" || normalized === "N/A" || normalized === "Optional") {
    return null;
  }

  return normalized;
}

function parseStringArray(value) {
  const normalized = normalizeNullableText(value);

  if (!normalized) {
    return null;
  }

  const values = normalized
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

  return values.length ? values : null;
}

function parseNumberArray(value) {
  const items = parseStringArray(value);

  if (!items) {
    return null;
  }

  const values = items.map((entry) => Number(entry)).filter(Number.isFinite);
  return values.length ? values : null;
}

function filamentPayload(option) {
  const sourceType = normalizeNullableText(detailValue(option, "Source Type")) ?? "global_custom";

  return {
    brand: detailValue(option, "Brand"),
    material_type: detailValue(option, "Material Type"),
    color: detailValue(option, "Color"),
    diameter: parseNumberFromText(detailValue(option, "Diameter")),
    melting_temp: parseNumberFromText(detailValue(option, "Melting Temp")),
    max_print_speed_mm_s: parseNumberFromText(detailValue(option, "Max Print Speed")),
    hex: normalizeNullableText(detailValue(option, "Hex")),
    density: parseNumberFromText(detailValue(option, "Density")),
    bed_temp: parseNumberFromText(detailValue(option, "Bed Temp")),
    bed_temp_range: parseRange(detailValue(option, "Bed Temp Range")),
    extruder_temp_range: parseRange(detailValue(option, "Extruder Temp Range")),
    finish: normalizeNullableText(detailValue(option, "Finish")),
    fill: normalizeNullableText(detailValue(option, "Fill")),
    pattern: normalizeNullableText(detailValue(option, "Pattern")),
    multi_color_direction: normalizeNullableText(detailValue(option, "Multi-Color Direction")),
    translucent: parseBoolean(detailValue(option, "Translucent")) ?? false,
    glow: parseBoolean(detailValue(option, "Glow")) ?? false,
    description: normalizeNullableText(detailValue(option, "Description")),
    notes: normalizeNullableText(detailValue(option, "Notes")),
    source_type: sourceType,
    created_by_company_id: sourceType === "global_custom" ? demoCompanyId : null
  };
}

function printerPayload(option) {
  const sourceType = normalizeNullableText(detailValue(option, "Source Type")) ?? "global_custom";

  return {
    brand: detailValue(option, "Brand"),
    model: detailValue(option, "Model"),
    print_technology: detailValue(option, "Print Technology"),
    build_volume_x_mm: parseNumberFromText(detailValue(option, "Build Volume X")),
    build_volume_y_mm: parseNumberFromText(detailValue(option, "Build Volume Y")),
    build_volume_z_mm: parseNumberFromText(detailValue(option, "Build Volume Z")),
    max_hotend_temp: parseNumberFromText(detailValue(option, "Max Hotend Temp")),
    max_bed_temp: parseNumberFromText(detailValue(option, "Max Bed Temp")),
    extruder_type: normalizeNullableText(detailValue(option, "Extruder Type")),
    nozzle_count: parseNumberFromText(detailValue(option, "Nozzle Count")) ?? 1,
    compatible_nozzle_diameters: parseNumberArray(
      detailValue(option, "Compatible Nozzle Diameters")
    ),
    compatible_materials: parseStringArray(detailValue(option, "Compatible Materials")),
    max_filament_diameter: parseNumberFromText(detailValue(option, "Max Filament Diameter")),
    is_multicolor: parseBoolean(detailValue(option, "Is Multicolor")) ?? false,
    ams_unit_count: parseNumberFromText(detailValue(option, "AMS Unit Count")),
    max_color_count: parseNumberFromText(detailValue(option, "Max Color Count")),
    uv_wavelength_nm: parseNumberFromText(detailValue(option, "UV Wavelength")),
    build_platform_type: normalizeNullableText(detailValue(option, "Build Platform Type")),
    has_camera: parseBoolean(detailValue(option, "Has Camera")) ?? false,
    has_enclosure: parseBoolean(detailValue(option, "Has Enclosure")) ?? false,
    has_filament_sensor: parseBoolean(detailValue(option, "Has Filament Sensor")) ?? false,
    network_capability: normalizeNullableText(detailValue(option, "Network Capability")),
    description: normalizeNullableText(detailValue(option, "Description")),
    notes: normalizeNullableText(detailValue(option, "Notes")),
    source_type: sourceType,
    created_by_company_id: sourceType === "global_custom" ? demoCompanyId : null
  };
}

async function ensureDemoCompany(client) {
  await client.query(
    `
      INSERT INTO companies (
        company_id,
        owner_user_id,
        name,
        slug,
        email,
        phone,
        address,
        country_code,
        plan_tier,
        plan_status,
        plan_started_at,
        is_active
      )
      VALUES (
        $1,
        'd0c0ffee-2222-4d9a-8f8f-222222222222',
        'XYZ Demo Company',
        'xyz-demo-company',
        'demo@xyz.local',
        '+20 100 000 0000',
        'Demo plant',
        'EG',
        'free',
        'active',
        now(),
        true
      )
      ON CONFLICT (company_id) DO NOTHING
    `,
    [demoCompanyId]
  );
}

async function seedFilamentReferences(client, references) {
  let inserted = 0;
  let skipped = 0;

  for (const option of references) {
    const payload = filamentPayload(option);

    const existing = await client.query(
      `
        SELECT filament_ref_id
        FROM filament_reference
        WHERE lower(brand) = lower($1)
          AND lower(material_type) = lower($2)
          AND lower(color) = lower($3)
          AND diameter = $4
        LIMIT 1
      `,
      [payload.brand, payload.material_type, payload.color, payload.diameter]
    );

    if (existing.rowCount) {
      skipped += 1;
      continue;
    }

    await client.query(
      `
        INSERT INTO filament_reference (
          company_id,
          created_by_company_id,
          brand,
          material_type,
          color,
          diameter,
          melting_temp,
          max_print_speed_mm_s,
          hex,
          density,
          bed_temp,
          bed_temp_range,
          extruder_temp_range,
          finish,
          fill,
          pattern,
          multi_color_direction,
          translucent,
          glow,
          description,
          notes,
          source_type
        )
        VALUES (
          NULL, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
          $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21
        )
      `,
      [
        payload.created_by_company_id,
        payload.brand,
        payload.material_type,
        payload.color,
        payload.diameter,
        payload.melting_temp,
        payload.max_print_speed_mm_s,
        payload.hex,
        payload.density,
        payload.bed_temp,
        payload.bed_temp_range ? JSON.stringify(payload.bed_temp_range) : null,
        payload.extruder_temp_range ? JSON.stringify(payload.extruder_temp_range) : null,
        payload.finish,
        payload.fill,
        payload.pattern,
        payload.multi_color_direction,
        payload.translucent,
        payload.glow,
        payload.description,
        payload.notes,
        payload.source_type
      ]
    );

    inserted += 1;
  }

  return { inserted, skipped };
}

async function seedPrinterReferences(client, references) {
  let inserted = 0;
  let skipped = 0;

  for (const option of references) {
    const payload = printerPayload(option);

    const existing = await client.query(
      `
        SELECT printer_ref_id
        FROM printer_reference
        WHERE lower(brand) = lower($1)
          AND lower(model) = lower($2)
        LIMIT 1
      `,
      [payload.brand, payload.model]
    );

    if (existing.rowCount) {
      skipped += 1;
      continue;
    }

    await client.query(
      `
        INSERT INTO printer_reference (
          company_id,
          created_by_company_id,
          source_type,
          brand,
          model,
          print_technology,
          build_volume_x_mm,
          build_volume_y_mm,
          build_volume_z_mm,
          max_hotend_temp,
          max_bed_temp,
          extruder_type,
          nozzle_count,
          compatible_nozzle_diameters,
          compatible_materials,
          max_filament_diameter,
          is_multicolor,
          ams_unit_count,
          max_color_count,
          uv_wavelength_nm,
          build_platform_type,
          has_camera,
          has_enclosure,
          has_filament_sensor,
          network_capability,
          description,
          notes
        )
        VALUES (
          NULL, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
          $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22,
          $23, $24, $25, $26
        )
      `,
      [
        payload.created_by_company_id,
        payload.source_type,
        payload.brand,
        payload.model,
        payload.print_technology,
        payload.build_volume_x_mm,
        payload.build_volume_y_mm,
        payload.build_volume_z_mm,
        payload.max_hotend_temp,
        payload.max_bed_temp,
        payload.extruder_type,
        payload.nozzle_count,
        payload.compatible_nozzle_diameters,
        payload.compatible_materials,
        payload.max_filament_diameter,
        payload.is_multicolor,
        payload.ams_unit_count,
        payload.max_color_count,
        payload.uv_wavelength_nm,
        payload.build_platform_type,
        payload.has_camera,
        payload.has_enclosure,
        payload.has_filament_sensor,
        payload.network_capability,
        payload.description,
        payload.notes
      ]
    );

    inserted += 1;
  }

  return { inserted, skipped };
}

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required.");
  }

  const { filamentReferences, printerReferences } = loadReferenceCatalog();
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  try {
    await ensureDemoCompany(client);
    const filamentResult = await seedFilamentReferences(client, filamentReferences);
    const printerResult = await seedPrinterReferences(client, printerReferences);
    const counts = await client.query(`
      SELECT
        (SELECT count(*) FROM filament_reference) AS filament_count,
        (SELECT count(*) FROM printer_reference) AS printer_count
    `);

    console.log(
      JSON.stringify(
        {
          filament: filamentResult,
          printers: printerResult,
          totals: counts.rows[0]
        },
        null,
        2
      )
    );
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
