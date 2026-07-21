import { Global, Module } from "@nestjs/common";
import { EmailModule } from "../email/email.module";
import { AdminAuditInterceptor } from "./admin-audit.interceptor";
import { AdminSessionService } from "./admin-session.service";
import { PlatformAdminGuard } from "./platform-admin.guard";
import { CompanyPurgeService } from "./company-purge.service";
import { DiscountService } from "./discount.service";
import { LicenseNotificationsService } from "./license-notifications.service";
import { LicensingAdminController } from "./licensing-admin.controller";
import { LicensingController } from "./licensing.controller";
import { LicensingService } from "./licensing.service";
import { PaymentsService } from "./payments.service";
import { SubscriptionInvoiceService } from "./subscription-invoice.service";

// Global: the LicenseGuard is an APP_GUARD and PrintersService/AuthController
// consume LicensingService directly, so every module gets it without imports.
// EmailModule supplies the transport for owner license notices (the
// LicenseNotificationsService sweep), admin-composed emails, and the
// subscription invoices issued on plan activation.
@Global()
@Module({
  imports: [EmailModule],
  controllers: [LicensingController, LicensingAdminController],
  providers: [
    LicensingService,
    PaymentsService,
    LicenseNotificationsService,
    SubscriptionInvoiceService,
    CompanyPurgeService,
    DiscountService,
    // Platform-admin step-up auth + its audit trail. Registered here (not as
    // APP_GUARD) because they gate ONLY the admin controller.
    AdminSessionService,
    PlatformAdminGuard,
    AdminAuditInterceptor
  ],
  exports: [LicensingService, PaymentsService, SubscriptionInvoiceService]
})
export class LicensingModule {}
