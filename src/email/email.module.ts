import { Module } from "@nestjs/common";
import { EmailService } from "./email.service";
import { OrderNotificationsService } from "./order-notifications.service";

// Customer-facing email. EmailService is the transport seam; the
// OrderNotificationsService sweeper drives the order-completion notifications
// off its OnModuleInit timer. DatabaseService is global (DatabaseModule is
// @Global) and ConfigModule is global, so nothing else needs importing here.
@Module({
  providers: [EmailService, OrderNotificationsService],
  exports: [EmailService]
})
export class EmailModule {}
