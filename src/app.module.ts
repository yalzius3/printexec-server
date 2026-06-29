import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { ConfigModule } from "@nestjs/config";
import { AssetsModule } from "./assets/assets.module";
import { AuthModule } from "./auth/auth.module";
import { CustomersModule } from "./customers/customers.module";
import { DatabaseModule } from "./database/database.module";
import { HealthController } from "./health/health.controller";
import { BedsModule } from "./beds/beds.module";
import { JobsModule } from "./jobs/jobs.module";
import { MaintenanceModule } from "./maintenance/maintenance.module";
import { OrderAttachmentsModule } from "./order-attachments/order-attachments.module";
import { OrderPiecesModule } from "./order-pieces/order-pieces.module";
import { OrdersModule } from "./orders/orders.module";
import { PrintersModule } from "./printers/printers.module";
import { SimpleJobsModule } from "./simple-jobs/simple-jobs.module";
import { StaffModule } from "./staff/staff.module";
import { UploadsModule } from "./uploads/uploads.module";
import { SupabaseAuthGuard } from "./auth/supabase.guard";
import { PermissionGuard } from "./auth/permission.guard";

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    DatabaseModule,
    AuthModule,
    AssetsModule,
    BedsModule,
    CustomersModule,
    JobsModule,
    MaintenanceModule,
    OrderAttachmentsModule,
    OrderPiecesModule,
    OrdersModule,
    PrintersModule,
    SimpleJobsModule,
    StaffModule,
    UploadsModule
  ],
  controllers: [HealthController],
  providers: [
    // Order matters: SupabaseAuthGuard must run first (sets req.permissions),
    // then PermissionGuard reads them.
    { provide: APP_GUARD, useClass: SupabaseAuthGuard },
    { provide: APP_GUARD, useClass: PermissionGuard }
  ]
})
export class AppModule {}
