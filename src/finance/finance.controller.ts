import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from "@nestjs/common";
import { CompanyId } from "../common/company-id.decorator";
import { UserId } from "../common/user-id.decorator";
import { RequirePermission } from "../auth/permission.decorator";
import { parseWithSchema } from "../common/zod";
import {
  accountIdParamSchema,
  asOfQuerySchema,
  billIdParamSchema,
  constantKeyParamSchema,
  costingIdParamSchema,
  createAccountSchema,
  createBillSchema,
  createCostingSchema,
  createExpenseSchema,
  createInvoiceSchema,
  createJournalEntrySchema,
  createPaymentSchema,
  createPresetSchema,
  createRecurringBillSchema,
  createTaxRateSchema,
  createVendorSchema,
  entryIdParamSchema,
  recurringBillIdParamSchema,
  expenseIdParamSchema,
  invoiceIdParamSchema,
  ledgerQuerySchema,
  listAccountsQuerySchema,
  listBillsQuerySchema,
  listExpensesQuerySchema,
  listInvoicesQuerySchema,
  listJournalQuerySchema,
  listPaymentsQuerySchema,
  listVendorsQuerySchema,
  orderIdParamSchema,
  paymentIdParamSchema,
  periodQuerySchema,
  presetIdParamSchema,
  taxRateIdParamSchema,
  updateAccountSchema,
  updateBillSchema,
  updateConstantSchema,
  updateCostingSchema,
  updateFinanceSettingsSchema,
  updateInvoiceSchema,
  updatePresetSchema,
  updateRecurringBillSchema,
  updateTaxRateSchema,
  updateVendorSchema,
  vendorIdParamSchema
} from "./finance.schemas";
import { InvoiceNotificationsService } from "../email/invoice-notifications.service";
import { FinanceService } from "./finance.service";
import { FinanceReportsService } from "./finance-reports.service";
import { FinanceCostingService } from "./finance-costing.service";

@Controller("finance")
export class FinanceController {
  constructor(
    private readonly financeService: FinanceService,
    private readonly reportsService: FinanceReportsService,
    private readonly costingService: FinanceCostingService,
    private readonly invoiceEmails: InvoiceNotificationsService
  ) {}

  // ── Dashboard ──────────────────────────────────────────────────────────────

  @Get("summary")
  @RequirePermission("view_finance")
  getSummary(@CompanyId() companyId: string) {
    return this.reportsService.summary(companyId);
  }

  // ── Chart of accounts ──────────────────────────────────────────────────────

  @Get("accounts")
  @RequirePermission("view_finance")
  listAccounts(@CompanyId() companyId: string, @Query() query: unknown) {
    return this.financeService.listAccounts(
      companyId,
      parseWithSchema(listAccountsQuerySchema, query)
    );
  }

  @Post("accounts")
  @RequirePermission("action_finance")
  createAccount(@CompanyId() companyId: string, @Body() body: unknown) {
    return this.financeService.createAccount(
      companyId,
      parseWithSchema(createAccountSchema, body)
    );
  }

  @Patch("accounts/:accountId")
  @RequirePermission("action_finance")
  updateAccount(
    @CompanyId() companyId: string,
    @Param() params: unknown,
    @Body() body: unknown
  ) {
    const { accountId } = parseWithSchema(accountIdParamSchema, params);
    return this.financeService.updateAccount(
      companyId,
      accountId,
      parseWithSchema(updateAccountSchema, body)
    );
  }

  @Delete("accounts/:accountId")
  @RequirePermission("action_finance")
  deleteAccount(@CompanyId() companyId: string, @Param() params: unknown) {
    const { accountId } = parseWithSchema(accountIdParamSchema, params);
    return this.financeService.deleteAccount(companyId, accountId);
  }

  @Get("accounts/:accountId/ledger")
  @RequirePermission("view_finance")
  accountLedger(
    @CompanyId() companyId: string,
    @Param() params: unknown,
    @Query() query: unknown
  ) {
    const { accountId } = parseWithSchema(accountIdParamSchema, params);
    return this.financeService.accountLedger(
      companyId,
      accountId,
      parseWithSchema(ledgerQuerySchema, query)
    );
  }

  // ── Vendors ────────────────────────────────────────────────────────────────

  @Get("vendors")
  @RequirePermission("view_finance")
  listVendors(@CompanyId() companyId: string, @Query() query: unknown) {
    return this.financeService.listVendors(
      companyId,
      parseWithSchema(listVendorsQuerySchema, query)
    );
  }

  @Post("vendors")
  @RequirePermission("action_finance")
  createVendor(@CompanyId() companyId: string, @Body() body: unknown) {
    return this.financeService.createVendor(
      companyId,
      parseWithSchema(createVendorSchema, body)
    );
  }

  @Patch("vendors/:vendorId")
  @RequirePermission("action_finance")
  updateVendor(
    @CompanyId() companyId: string,
    @Param() params: unknown,
    @Body() body: unknown
  ) {
    const { vendorId } = parseWithSchema(vendorIdParamSchema, params);
    return this.financeService.updateVendor(
      companyId,
      vendorId,
      parseWithSchema(updateVendorSchema, body)
    );
  }

  @Delete("vendors/:vendorId")
  @RequirePermission("action_finance")
  deleteVendor(@CompanyId() companyId: string, @Param() params: unknown) {
    const { vendorId } = parseWithSchema(vendorIdParamSchema, params);
    return this.financeService.deleteVendor(companyId, vendorId);
  }

  // ── Recurring bills (routine costs) ─────────────────────────────────────────

  @Get("recurring-bills")
  @RequirePermission("view_finance")
  listRecurringBills(@CompanyId() companyId: string) {
    return this.financeService.listRecurringBills(companyId);
  }

  @Post("recurring-bills")
  @RequirePermission("action_finance")
  createRecurringBill(
    @CompanyId() companyId: string,
    @UserId() userId: string,
    @Body() body: unknown
  ) {
    return this.financeService.createRecurringBill(
      companyId,
      userId,
      parseWithSchema(createRecurringBillSchema, body)
    );
  }

  @Patch("recurring-bills/:recurringBillId")
  @RequirePermission("action_finance")
  updateRecurringBill(
    @CompanyId() companyId: string,
    @Param() params: unknown,
    @Body() body: unknown
  ) {
    const { recurringBillId } = parseWithSchema(recurringBillIdParamSchema, params);
    return this.financeService.updateRecurringBill(
      companyId,
      recurringBillId,
      parseWithSchema(updateRecurringBillSchema, body)
    );
  }

  @Delete("recurring-bills/:recurringBillId")
  @RequirePermission("action_finance")
  deleteRecurringBill(@CompanyId() companyId: string, @Param() params: unknown) {
    const { recurringBillId } = parseWithSchema(recurringBillIdParamSchema, params);
    return this.financeService.deleteRecurringBill(companyId, recurringBillId);
  }

  @Post("recurring-bills/:recurringBillId/post")
  @RequirePermission("action_finance")
  postRecurringBill(
    @CompanyId() companyId: string,
    @UserId() userId: string,
    @Param() params: unknown
  ) {
    const { recurringBillId } = parseWithSchema(recurringBillIdParamSchema, params);
    return this.financeService.postRecurringBill(companyId, userId, recurringBillId);
  }

  // ── Tax rates ──────────────────────────────────────────────────────────────

  @Get("tax-rates")
  @RequirePermission("view_finance")
  listTaxRates(@CompanyId() companyId: string) {
    return this.financeService.listTaxRates(companyId);
  }

  @Post("tax-rates")
  @RequirePermission("action_finance")
  createTaxRate(@CompanyId() companyId: string, @Body() body: unknown) {
    return this.financeService.createTaxRate(
      companyId,
      parseWithSchema(createTaxRateSchema, body)
    );
  }

  @Patch("tax-rates/:taxRateId")
  @RequirePermission("action_finance")
  updateTaxRate(
    @CompanyId() companyId: string,
    @Param() params: unknown,
    @Body() body: unknown
  ) {
    const { taxRateId } = parseWithSchema(taxRateIdParamSchema, params);
    return this.financeService.updateTaxRate(
      companyId,
      taxRateId,
      parseWithSchema(updateTaxRateSchema, body)
    );
  }

  // ── Settings ───────────────────────────────────────────────────────────────

  @Get("settings")
  @RequirePermission("view_finance")
  getSettings(@CompanyId() companyId: string) {
    return this.financeService.getSettings(companyId);
  }

  @Patch("settings")
  @RequirePermission("action_finance")
  updateSettings(@CompanyId() companyId: string, @Body() body: unknown) {
    return this.financeService.updateSettings(
      companyId,
      parseWithSchema(updateFinanceSettingsSchema, body)
    );
  }

  // ── Invoices ───────────────────────────────────────────────────────────────

  @Get("invoices")
  @RequirePermission("view_finance")
  listInvoices(@CompanyId() companyId: string, @Query() query: unknown) {
    return this.financeService.listInvoices(
      companyId,
      parseWithSchema(listInvoicesQuerySchema, query)
    );
  }

  // Order staff see the invoice window pop open the instant they confirm an
  // order, so a single invoice read is allowed with view_orders too.
  @Get("invoices/:invoiceId")
  @RequirePermission(["view_finance", "view_orders"])
  getInvoice(@CompanyId() companyId: string, @Param() params: unknown) {
    const { invoiceId } = parseWithSchema(invoiceIdParamSchema, params);
    return this.financeService.getInvoice(companyId, invoiceId);
  }

  @Post("invoices")
  @RequirePermission("action_finance")
  createInvoice(
    @CompanyId() companyId: string,
    @UserId() userId: string,
    @Body() body: unknown
  ) {
    return this.financeService.createInvoice(
      companyId,
      userId,
      parseWithSchema(createInvoiceSchema, body)
    );
  }

  // Cross-module flow: order staff generate the draft from the order editor,
  // so action_orders is accepted alongside action_finance.
  @Post("invoices/from-order/:orderId")
  @RequirePermission(["action_finance", "action_orders"])
  createInvoiceFromOrder(
    @CompanyId() companyId: string,
    @UserId() userId: string,
    @Param() params: unknown
  ) {
    const { orderId } = parseWithSchema(orderIdParamSchema, params);
    return this.financeService.createInvoiceFromOrder(companyId, userId, orderId);
  }

  @Patch("invoices/:invoiceId")
  @RequirePermission("action_finance")
  updateInvoice(
    @CompanyId() companyId: string,
    @Param() params: unknown,
    @Body() body: unknown
  ) {
    const { invoiceId } = parseWithSchema(invoiceIdParamSchema, params);
    return this.financeService.updateInvoice(
      companyId,
      invoiceId,
      parseWithSchema(updateInvoiceSchema, body)
    );
  }

  @Post("invoices/:invoiceId/issue")
  @RequirePermission("action_finance")
  issueInvoice(
    @CompanyId() companyId: string,
    @UserId() userId: string,
    @Param() params: unknown
  ) {
    const { invoiceId } = parseWithSchema(invoiceIdParamSchema, params);
    return this.financeService.issueInvoice(companyId, userId, invoiceId);
  }

  @Post("invoices/:invoiceId/void")
  @RequirePermission("action_finance")
  voidInvoice(
    @CompanyId() companyId: string,
    @UserId() userId: string,
    @Param() params: unknown
  ) {
    const { invoiceId } = parseWithSchema(invoiceIdParamSchema, params);
    return this.financeService.voidInvoice(companyId, userId, invoiceId);
  }

  // ── Invoice → customer email ───────────────────────────────────────────────
  // Issuing an invoice emails it automatically (FinanceService.issueInvoice).
  // These two exist for what automation can't decide: showing the operator
  // whether it actually reached the customer, and sending it again.

  // Readable by anyone who can see finance — it's delivery status, not money.
  @Get("invoices/:invoiceId/email")
  @RequirePermission("view_finance")
  getInvoiceEmailState(@CompanyId() companyId: string, @Param() params: unknown) {
    const { invoiceId } = parseWithSchema(invoiceIdParamSchema, params);
    return this.invoiceEmails.getEmailState(companyId, invoiceId);
  }

  // Cross-module flow, same reasoning as invoices/from-order: order staff who
  // raised the bill need to be able to re-send it without finance rights.
  @Post("invoices/:invoiceId/email")
  @RequirePermission(["action_finance", "action_orders"])
  async resendInvoiceEmail(@CompanyId() companyId: string, @Param() params: unknown) {
    const { invoiceId } = parseWithSchema(invoiceIdParamSchema, params);
    const outcome = await this.invoiceEmails.resendForInvoice(companyId, invoiceId);
    // Reflect the stored row back, so the UI updates from one source of truth.
    return { outcome, ...(await this.invoiceEmails.getEmailState(companyId, invoiceId)) };
  }

  // ── Bills ──────────────────────────────────────────────────────────────────

  @Get("bills")
  @RequirePermission("view_finance")
  listBills(@CompanyId() companyId: string, @Query() query: unknown) {
    return this.financeService.listBills(
      companyId,
      parseWithSchema(listBillsQuerySchema, query)
    );
  }

  @Get("bills/:billId")
  @RequirePermission("view_finance")
  getBill(@CompanyId() companyId: string, @Param() params: unknown) {
    const { billId } = parseWithSchema(billIdParamSchema, params);
    return this.financeService.getBill(companyId, billId);
  }

  @Post("bills")
  @RequirePermission("action_finance")
  createBill(
    @CompanyId() companyId: string,
    @UserId() userId: string,
    @Body() body: unknown
  ) {
    return this.financeService.createBill(
      companyId,
      userId,
      parseWithSchema(createBillSchema, body)
    );
  }

  @Patch("bills/:billId")
  @RequirePermission("action_finance")
  updateBill(
    @CompanyId() companyId: string,
    @Param() params: unknown,
    @Body() body: unknown
  ) {
    const { billId } = parseWithSchema(billIdParamSchema, params);
    return this.financeService.updateBill(
      companyId,
      billId,
      parseWithSchema(updateBillSchema, body)
    );
  }

  @Post("bills/:billId/open")
  @RequirePermission("action_finance")
  openBill(
    @CompanyId() companyId: string,
    @UserId() userId: string,
    @Param() params: unknown
  ) {
    const { billId } = parseWithSchema(billIdParamSchema, params);
    return this.financeService.openBill(companyId, userId, billId);
  }

  @Post("bills/:billId/void")
  @RequirePermission("action_finance")
  voidBill(
    @CompanyId() companyId: string,
    @UserId() userId: string,
    @Param() params: unknown
  ) {
    const { billId } = parseWithSchema(billIdParamSchema, params);
    return this.financeService.voidBill(companyId, userId, billId);
  }

  // ── Payments ───────────────────────────────────────────────────────────────

  @Get("payments")
  @RequirePermission("view_finance")
  listPayments(@CompanyId() companyId: string, @Query() query: unknown) {
    return this.financeService.listPayments(
      companyId,
      parseWithSchema(listPaymentsQuerySchema, query)
    );
  }

  @Post("payments")
  @RequirePermission("action_finance")
  createPayment(
    @CompanyId() companyId: string,
    @UserId() userId: string,
    @Body() body: unknown
  ) {
    return this.financeService.createPayment(
      companyId,
      userId,
      parseWithSchema(createPaymentSchema, body)
    );
  }

  @Post("payments/:paymentId/void")
  @RequirePermission("action_finance")
  voidPayment(
    @CompanyId() companyId: string,
    @UserId() userId: string,
    @Param() params: unknown
  ) {
    const { paymentId } = parseWithSchema(paymentIdParamSchema, params);
    return this.financeService.voidPayment(companyId, userId, paymentId);
  }

  // ── Expenses ───────────────────────────────────────────────────────────────

  @Get("expenses")
  @RequirePermission("view_finance")
  listExpenses(@CompanyId() companyId: string, @Query() query: unknown) {
    return this.financeService.listExpenses(
      companyId,
      parseWithSchema(listExpensesQuerySchema, query)
    );
  }

  @Post("expenses")
  @RequirePermission("action_finance")
  createExpense(
    @CompanyId() companyId: string,
    @UserId() userId: string,
    @Body() body: unknown
  ) {
    return this.financeService.createExpense(
      companyId,
      userId,
      parseWithSchema(createExpenseSchema, body)
    );
  }

  @Post("expenses/:expenseId/void")
  @RequirePermission("action_finance")
  voidExpense(
    @CompanyId() companyId: string,
    @UserId() userId: string,
    @Param() params: unknown
  ) {
    const { expenseId } = parseWithSchema(expenseIdParamSchema, params);
    return this.financeService.voidExpense(companyId, userId, expenseId);
  }

  // ── Journal ────────────────────────────────────────────────────────────────

  @Get("journal")
  @RequirePermission("view_finance")
  listJournal(@CompanyId() companyId: string, @Query() query: unknown) {
    return this.financeService.listJournal(
      companyId,
      parseWithSchema(listJournalQuerySchema, query)
    );
  }

  @Get("journal/:entryId")
  @RequirePermission("view_finance")
  getJournalEntry(@CompanyId() companyId: string, @Param() params: unknown) {
    const { entryId } = parseWithSchema(entryIdParamSchema, params);
    return this.financeService.getJournalEntry(companyId, entryId);
  }

  @Post("journal")
  @RequirePermission("action_finance")
  createManualEntry(
    @CompanyId() companyId: string,
    @UserId() userId: string,
    @Body() body: unknown
  ) {
    return this.financeService.createManualEntry(
      companyId,
      userId,
      parseWithSchema(createJournalEntrySchema, body)
    );
  }

  // ── Costing variables (capital-recovery calculators) ────────────────────────

  @Get("costing")
  @RequirePermission("view_finance")
  listCosting(@CompanyId() companyId: string) {
    return this.costingService.list(companyId);
  }

  // Read by the Orders pricing screen too (optional recovery-margin quote hint),
  // so order viewers can reach it without the Finance module.
  @Get("costing/summary")
  @RequirePermission(["view_finance", "view_orders"])
  costingSummary(@CompanyId() companyId: string) {
    return this.costingService.summary(companyId);
  }

  @Get("costing/assets")
  @RequirePermission("view_finance")
  recoverableAssets(@CompanyId() companyId: string) {
    return this.costingService.recoverableAssets(companyId);
  }

  // Auto-derived cost factors for the Costing page (rates, materials, payroll,
  // rent, recovery). Payroll is visible to any finance user.
  @Get("costing/factors")
  @RequirePermission("view_finance")
  costFactors(@CompanyId() companyId: string) {
    return this.costingService.costFactors(companyId);
  }

  // ── Finance constants ────────────────────────────────────────────────────

  @Get("constants")
  @RequirePermission("view_finance")
  getConstants(@CompanyId() companyId: string) {
    return this.costingService.getConstants(companyId);
  }

  @Patch("constants/:key")
  @RequirePermission("action_finance")
  updateConstant(
    @CompanyId() companyId: string,
    @Param() params: unknown,
    @Body() body: unknown
  ) {
    const { key } = parseWithSchema(constantKeyParamSchema, params);
    const { override_value } = parseWithSchema(updateConstantSchema, body);
    return this.costingService.updateConstant(companyId, key, override_value);
  }

  @Post("costing")
  @RequirePermission("action_finance")
  createCosting(
    @CompanyId() companyId: string,
    @UserId() userId: string,
    @Body() body: unknown
  ) {
    return this.costingService.create(
      companyId,
      userId,
      parseWithSchema(createCostingSchema, body)
    );
  }

  @Patch("costing/:costingId")
  @RequirePermission("action_finance")
  updateCosting(
    @CompanyId() companyId: string,
    @Param() params: unknown,
    @Body() body: unknown
  ) {
    const { costingId } = parseWithSchema(costingIdParamSchema, params);
    return this.costingService.update(
      companyId,
      costingId,
      parseWithSchema(updateCostingSchema, body)
    );
  }

  @Delete("costing/:costingId")
  @RequirePermission("action_finance")
  deleteCosting(@CompanyId() companyId: string, @Param() params: unknown) {
    const { costingId } = parseWithSchema(costingIdParamSchema, params);
    return this.costingService.remove(companyId, costingId);
  }

  // ── Costing presets (reusable pricing formulas) ─────────────────────────────

  // Read by the Orders pricing screen too (to pick/apply a preset), so order
  // staff can list them without the Finance module.
  @Get("costing/presets")
  @RequirePermission(["view_finance", "view_orders"])
  listPresets(@CompanyId() companyId: string) {
    return this.costingService.listPresets(companyId);
  }

  @Post("costing/presets")
  @RequirePermission("action_finance")
  createPreset(
    @CompanyId() companyId: string,
    @UserId() userId: string,
    @Body() body: unknown
  ) {
    return this.costingService.createPreset(
      companyId,
      userId,
      parseWithSchema(createPresetSchema, body)
    );
  }

  @Patch("costing/presets/:presetId")
  @RequirePermission("action_finance")
  updatePreset(
    @CompanyId() companyId: string,
    @Param() params: unknown,
    @Body() body: unknown
  ) {
    const { presetId } = parseWithSchema(presetIdParamSchema, params);
    return this.costingService.updatePreset(
      companyId,
      presetId,
      parseWithSchema(updatePresetSchema, body)
    );
  }

  @Delete("costing/presets/:presetId")
  @RequirePermission("action_finance")
  deletePreset(@CompanyId() companyId: string, @Param() params: unknown) {
    const { presetId } = parseWithSchema(presetIdParamSchema, params);
    return this.costingService.removePreset(companyId, presetId);
  }

  // ── Reports ────────────────────────────────────────────────────────────────

  @Get("reports/trial-balance")
  @RequirePermission("view_finance")
  trialBalance(@CompanyId() companyId: string, @Query() query: unknown) {
    return this.reportsService.trialBalance(
      companyId,
      parseWithSchema(periodQuerySchema, query)
    );
  }

  @Get("reports/profit-loss")
  @RequirePermission("view_finance")
  profitLoss(@CompanyId() companyId: string, @Query() query: unknown) {
    return this.reportsService.profitAndLoss(
      companyId,
      parseWithSchema(periodQuerySchema, query)
    );
  }

  @Get("reports/balance-sheet")
  @RequirePermission("view_finance")
  balanceSheet(@CompanyId() companyId: string, @Query() query: unknown) {
    const { as_of } = parseWithSchema(asOfQuerySchema, query);
    return this.reportsService.balanceSheet(companyId, as_of);
  }
}
