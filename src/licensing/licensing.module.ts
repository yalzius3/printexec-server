import { Global, Module } from "@nestjs/common";
import { LicensingAdminController } from "./licensing-admin.controller";
import { LicensingController } from "./licensing.controller";
import { LicensingService } from "./licensing.service";
import { PaymentsService } from "./payments.service";

// Global: the LicenseGuard is an APP_GUARD and PrintersService/AuthController
// consume LicensingService directly, so every module gets it without imports.
@Global()
@Module({
  controllers: [LicensingController, LicensingAdminController],
  providers: [LicensingService, PaymentsService],
  exports: [LicensingService, PaymentsService]
})
export class LicensingModule {}
