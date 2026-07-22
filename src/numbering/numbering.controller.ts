import { Body, Controller, Get, Param, Post, UnauthorizedException } from "@nestjs/common";
import { CompanyId } from "../common/company-id.decorator";
import { UserRole } from "../common/user-role.decorator";
import { parseWithSchema } from "../common/zod";
import { numberingKindParamSchema, setNextNumberSchema } from "./numbering.schemas";
import { NumberingService } from "./numbering.service";

// Document numbering lives under Company settings in the UI, so it follows the
// same access rule as the rest of that panel: owner-only, gated on the request
// context the auth guard already resolved (no re-query), exactly like
// AuthController's electricity-price / slicer-storage-mode endpoints.
@Controller("numbering")
export class NumberingController {
  constructor(private readonly numbering: NumberingService) {}

  // Readable by any member — the Company settings panel renders it read-only
  // for staff, and knowing the next order number leaks nothing.
  @Get()
  getState(@CompanyId() companyId: string) {
    return this.numbering.getState(companyId);
  }

  @Post(":kind")
  setNextValue(
    @CompanyId() companyId: string,
    @UserRole() role: "owner" | "staff",
    @Param() params: unknown,
    @Body() body: unknown
  ) {
    if (role !== "owner") {
      throw new UnauthorizedException("Only the company owner can change document numbering.");
    }
    const { kind } = parseWithSchema(numberingKindParamSchema, params);
    const { next_value } = parseWithSchema(setNextNumberSchema, body);
    return this.numbering.setNextValue(companyId, kind, next_value);
  }
}
