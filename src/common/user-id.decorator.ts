import { createParamDecorator, type ExecutionContext } from "@nestjs/common";
import type { AuthRequest } from "../auth/supabase.guard";

export const UserId = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string => {
    const req = ctx.switchToHttp().getRequest<AuthRequest>();
    return req.userId;
  }
);
