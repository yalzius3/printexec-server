import { Body, Controller, Get, Param, Patch, Post, Query, Delete } from "@nestjs/common";
import { CompanyId } from "../common/company-id.decorator";
import { RequirePermission } from "../auth/permission.decorator";
import { parseWithSchema } from "../common/zod";
import {
  createCustomerSchema,
  customerIdParamSchema,
  listCustomersQuerySchema,
  updateCustomerSchema,
  createInteractionSchema,
  listInteractionsQuerySchema
} from "./customers.schemas";
import { CustomersService } from "./customers.service";

@Controller("customers")
export class CustomersController {
  constructor(private readonly customersService: CustomersService) { }

  @Get()
  @RequirePermission("view_customers")
  listCustomers(
    @CompanyId() companyId: string,
    @Query() query: unknown
  ) {
    return this.customersService.listCustomers(
      companyId,
      parseWithSchema(listCustomersQuerySchema, query)
    );
  }

  @Get("history")
  @RequirePermission("view_customers")
  getGlobalHistory(
    @CompanyId() companyId: string,
    @Query() query: unknown
  ) {
    const parsed = parseWithSchema(listInteractionsQuerySchema, query);
    return this.customersService.getGlobalInteractions(
      companyId,
      parsed.days ?? 30,
      parsed.interaction_type
    );
  }

  @Get(":customerId")
  @RequirePermission("view_customers")
  getCustomer(
    @CompanyId() companyId: string,
    @Param() params: unknown
  ) {
    const { customerId } = parseWithSchema(customerIdParamSchema, params);
    return this.customersService.getCustomerById(companyId, customerId);
  }

  @Post()
  @RequirePermission("action_customers")
  createCustomer(
    @CompanyId() companyId: string,
    @Body() body: unknown
  ) {
    return this.customersService.createCustomer(
      companyId,
      parseWithSchema(createCustomerSchema, body)
    );
  }

  @Patch(":customerId")
  @RequirePermission("action_customers")
  updateCustomer(
    @CompanyId() companyId: string,
    @Param() params: unknown,
    @Body() body: unknown
  ) {
    const { customerId } = parseWithSchema(customerIdParamSchema, params);
    return this.customersService.updateCustomer(
      companyId,
      customerId,
      parseWithSchema(updateCustomerSchema, body)
    );
  }

  @Delete(":customerId")
  @RequirePermission("action_customers")
  deleteCustomer(
    @CompanyId() companyId: string,
    @Param() params: unknown
  ) {
    const { customerId } = parseWithSchema(customerIdParamSchema, params);
    return this.customersService.deleteCustomer(companyId, customerId);
  }

  @Post(":customerId/restore")
  @RequirePermission("action_customers")
  restoreCustomer(
    @CompanyId() companyId: string,
    @Param() params: unknown
  ) {
    const { customerId } = parseWithSchema(customerIdParamSchema, params);
    return this.customersService.restoreCustomer(companyId, customerId);
  }

  @Get(":customerId/interactions")
  @RequirePermission("view_customers")
  getInteractions(
    @CompanyId() companyId: string,
    @Param() params: unknown
  ) {
    const { customerId } = parseWithSchema(customerIdParamSchema, params);
    return this.customersService.getInteractions(companyId, customerId);
  }

  @Post(":customerId/interactions")
  @RequirePermission("action_customers")
  addInteraction(
    @CompanyId() companyId: string,
    @Param() params: unknown,
    @Body() body: unknown
  ) {
    const { customerId } = parseWithSchema(customerIdParamSchema, params);
    const parsed = parseWithSchema(createInteractionSchema, body);
    return this.customersService.logInteraction(
      companyId,
      customerId,
      parsed.interaction_type,
      parsed.description
    );
  }
}
