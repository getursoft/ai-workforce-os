-- AlterTable
ALTER TABLE "hr_employee_configurations" ADD COLUMN "api_enabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "api_endpoint" VARCHAR(500),
ADD COLUMN "api_key" VARCHAR(500);

-- AlterTable
ALTER TABLE "finance_employee_configurations" ADD COLUMN "api_enabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "api_endpoint" VARCHAR(500),
ADD COLUMN "api_key" VARCHAR(500);

-- AlterTable
ALTER TABLE "it_support_employee_configurations" ADD COLUMN "api_enabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "api_endpoint" VARCHAR(500),
ADD COLUMN "api_key" VARCHAR(500);

-- AlterTable
ALTER TABLE "sales_employee_configurations" ADD COLUMN "api_enabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "api_endpoint" VARCHAR(500),
ADD COLUMN "api_key" VARCHAR(500);

-- AlterTable
ALTER TABLE "marketing_employee_configurations" ADD COLUMN "api_enabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "api_endpoint" VARCHAR(500),
ADD COLUMN "api_key" VARCHAR(500);

-- AlterTable
ALTER TABLE "customer_support_employee_configurations" ADD COLUMN "api_enabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "api_endpoint" VARCHAR(500),
ADD COLUMN "api_key" VARCHAR(500);
