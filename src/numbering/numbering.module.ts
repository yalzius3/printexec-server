import { Module } from "@nestjs/common";
import { NumberingController } from "./numbering.controller";
import { NumberingService } from "./numbering.service";

// Business-serial control (order numbers + invoice numbers). Owns no tables of
// its own — it reads and repositions the counters Orders and Finance mint from.
// DatabaseModule is @Global, so nothing needs importing here.
@Module({
  controllers: [NumberingController],
  providers: [NumberingService]
})
export class NumberingModule {}
