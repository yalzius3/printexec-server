import { Module } from "@nestjs/common";
import { AuthController } from "./auth.controller";
import { ThrottleGuard } from "../common/throttle.guard";

// ThrottleGuard is provided per-module rather than globally, so this module and
// LicensingModule each hold their own instance. That is deliberate and safe:
// buckets are keyed by "METHOD path|caller" and the two modules guard disjoint
// routes, so no key is ever shared and no budget is ever doubled.
@Module({
  controllers: [AuthController],
  providers: [ThrottleGuard]
})
export class AuthModule {}
