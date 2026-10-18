-- AlterTable
ALTER TABLE "recruitment_resumes" ADD COLUMN     "extracted_skills" JSONB,
ADD COLUMN     "relevant_experience_years" INTEGER,
ADD COLUMN     "total_experience_years" INTEGER;

-- CreateIndex
CREATE INDEX "recruitment_resumes_organization_id_total_experience_years_idx" ON "recruitment_resumes"("organization_id", "total_experience_years");

-- CreateIndex
CREATE INDEX "recruitment_resumes_organization_id_relevant_experience_yea_idx" ON "recruitment_resumes"("organization_id", "relevant_experience_years");

