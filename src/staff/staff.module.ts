import { Module } from "@nestjs/common";
import { EmailModule } from "../email/email.module";
import { StaffController } from "./staff.controller";
import { StaffService } from "./staff.service";

@Module({
  imports: [EmailModule],
  controllers: [StaffController],
  providers: [StaffService]
})
export class StaffModule {}
