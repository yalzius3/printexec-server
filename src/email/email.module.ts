import { Module } from "@nestjs/common";
import { EmailService } from "./email.service";
import { InvoiceNotificationsService } from "./invoice-notifications.service";
import { OrderNotificationsService } from "./order-notifications.service";

// Customer-facing email. EmailService is the transport seam; the two sweeper
// services drive their notifications off their own OnModuleInit timers.
// DatabaseService is global (DatabaseModule is @Global) and ConfigModule is
// global, so nothing else needs importing here.
//
// InvoiceNotificationsService is exported so FinanceModule can nudge it the
// moment an invoice is issued (its sweep is the safety net, not the only path).
@Module({
  providers: [EmailService, OrderNotificationsService, InvoiceNotificationsService],
  exports: [EmailService, InvoiceNotificationsService]
})
export class EmailModule {}
