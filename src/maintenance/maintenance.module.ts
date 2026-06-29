import { Module } from "@nestjs/common";
import { FilePurgeService } from "./file-purge.service";

// Houses background retention/housekeeping sweepers. DatabaseService is provided
// globally (DatabaseModule is @Global) and ConfigModule is global, so this
// module only needs to register the service for its OnModuleInit timer to start.
@Module({
  providers: [FilePurgeService]
})
export class MaintenanceModule {}
