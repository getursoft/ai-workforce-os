import { describe, expect, it, vi } from "vitest";
import { createTeamApi } from "./team-api";
describe("team api", () => {
  it("generates filters and all member requests", async () => {
    const request = vi.fn().mockResolvedValue({});
    const api = createTeamApi({ request } as never);
    await api.list({ page: 2, search: "eng", status: "ACTIVE", managerId: "m" });
    await api.create({ name: "Engineering" });
    await api.update("t", { parentTeamId: null });
    await api.members("t", { role: "LEAD" });
    await api.addMember("t", "u", "MEMBER");
    await api.updateMember("t", "u", "LEAD");
    await api.removeMember("t", "u");
    await api.remove("t");
    expect(request).toHaveBeenCalledWith("/teams?page=2&search=eng&status=ACTIVE&managerId=m");
    expect(request).toHaveBeenCalledWith("/teams/t/members/u", {
      method: "PATCH",
      body: JSON.stringify({ role: "LEAD" })
    });
    expect(request).toHaveBeenCalledWith("/teams/t", { method: "DELETE" });
  });
});
