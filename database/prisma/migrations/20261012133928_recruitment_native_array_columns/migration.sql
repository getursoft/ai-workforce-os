-- AlterTable
ALTER TABLE "recruitment_candidates" DROP COLUMN "preferred_work_locations",
ADD COLUMN     "preferred_work_locations" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "recruitment_resumes" DROP COLUMN "extracted_skills",
ADD COLUMN     "extracted_skills" TEXT[] DEFAULT ARRAY[]::TEXT[];

