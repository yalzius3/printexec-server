import { createParamDecorator, type ExecutionContext } from "@nestjs/common";
import type { AuthRequest } from "../auth/supabase.guard";

export const UserRole = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): "owner" | "staff" => {
    const req = ctx.switchToHttp().getRequest<AuthRequest>();
    return req.userRole;
  }
);
