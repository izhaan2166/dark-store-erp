import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { type Api, ApiError, type StaffMember } from "../src/api";
import { Staff } from "../src/screens/Staff";

const RAVI: StaffMember = { userId: "u1", name: "Ravi", email: "ravi@store.in", roles: ["picker"], editable: true };
const ME: StaffMember = { userId: "u0", name: "Ayesha", email: "ayesha@store.in", roles: ["store_manager"], editable: false };

function fakeApi(overrides: Partial<Record<keyof Api, unknown>> = {}): Api {
  return {
    staff: vi.fn().mockResolvedValue([ME, RAVI]),
    addStaff: vi.fn(async (_s: string, body: { name: string; email: string }) => ({ ...RAVI, userId: "u2", name: body.name, email: body.email })),
    setStaffRoles: vi.fn(async (_s: string, _u: string, roles: StaffMember["roles"]) => (roles.length ? { ...RAVI, roles } : null)),
    setStaffPassword: vi.fn().mockResolvedValue({ userId: "u1" }),
    ...overrides,
  } as unknown as Api;
}

const rowOf = async (name: string) => (await screen.findByText(name)).closest("li") as HTMLElement;

describe("staff screen", () => {
  it("lists people with their roles and only offers changes where allowed", async () => {
    render(<Staff api={fakeApi()} storeId="s1" meId="u0" />);
    const ravi = await rowOf("Ravi");
    expect(ravi).toHaveTextContent("Picker");
    expect(within(ravi).getByRole("button", { name: "Change roles" })).toBeInTheDocument();
    const me = await rowOf("Ayesha");
    expect(me).toHaveTextContent("Store Manager");
    expect(me).toHaveTextContent("This is you.");
    expect(within(me).queryByRole("button")).not.toBeInTheDocument();
  });

  it("adds a person once every field is filled in", async () => {
    const api = fakeApi();
    const user = userEvent.setup();
    render(<Staff api={api} storeId="s1" meId="u0" />);
    await user.click(await screen.findByRole("button", { name: "Add person" }));
    const dialog = screen.getByRole("dialog", { name: "Add person" });
    const add = within(dialog).getByRole("button", { name: "Add person" });
    await user.type(within(dialog).getByLabelText("Name"), " Priya ");
    await user.type(within(dialog).getByLabelText(/Email/), "priya@store.in");
    await user.type(within(dialog).getByLabelText(/First password/), "short");
    await user.click(within(dialog).getByLabelText(/Packer/));
    expect(add).toBeDisabled();
    await user.type(within(dialog).getByLabelText(/First password/), " enough");
    await user.click(add);
    expect(api.addStaff).toHaveBeenCalledWith("s1", { name: "Priya", email: "priya@store.in", password: "short enough", roles: ["packer"] }, expect.any(String));
    expect(await screen.findByRole("status")).toHaveTextContent("Priya added. They can sign in with priya@store.in");
    expect(api.staff).toHaveBeenCalledTimes(2);
  });

  it("keeps the dialog open with the reason when adding fails", async () => {
    const addStaff = vi.fn().mockRejectedValue(new ApiError(409, "conflict", "Someone with this email already has an account"));
    const user = userEvent.setup();
    render(<Staff api={fakeApi({ addStaff })} storeId="s1" meId="u0" />);
    await user.click(await screen.findByRole("button", { name: "Add person" }));
    const dialog = screen.getByRole("dialog", { name: "Add person" });
    await user.type(within(dialog).getByLabelText("Name"), "Ravi again");
    await user.type(within(dialog).getByLabelText(/Email/), "ravi@store.in");
    await user.type(within(dialog).getByLabelText(/First password/), "long enough pw");
    await user.click(within(dialog).getByLabelText(/Picker/));
    await user.click(within(dialog).getByRole("button", { name: "Add person" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("already has an account");
  });

  it("changes roles, resending with the same key until the choice changes", async () => {
    const setStaffRoles = vi.fn().mockRejectedValueOnce(new ApiError(0, "offline", "No connection")).mockResolvedValue({ ...RAVI, roles: ["packer", "picker"] });
    const user = userEvent.setup();
    render(<Staff api={fakeApi({ setStaffRoles })} storeId="s1" meId="u0" />);
    await user.click(within(await rowOf("Ravi")).getByRole("button", { name: "Change roles" }));
    const dialog = screen.getByRole("dialog", { name: "Roles of Ravi" });
    const save = within(dialog).getByRole("button", { name: "Save roles" });
    expect(save).toBeDisabled();
    await user.click(within(dialog).getByLabelText(/Packer/));
    await user.click(save);
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("No connection");
    await user.click(save);
    await waitFor(() => expect(setStaffRoles).toHaveBeenCalledTimes(2));
    expect(setStaffRoles.mock.calls[1]![3]).toBe(setStaffRoles.mock.calls[0]![3]);
    expect(setStaffRoles).toHaveBeenLastCalledWith("s1", "u1", ["picker", "packer"], expect.any(String));
    expect(await screen.findByRole("status")).toHaveTextContent("Ravi is now Packer, Picker.");
  });

  it("removes a person only after a second tap", async () => {
    const api = fakeApi();
    const user = userEvent.setup();
    render(<Staff api={api} storeId="s1" meId="u0" />);
    await user.click(within(await rowOf("Ravi")).getByRole("button", { name: "Change roles" }));
    const dialog = screen.getByRole("dialog", { name: "Roles of Ravi" });
    await user.click(within(dialog).getByRole("button", { name: "Remove from store" }));
    expect(api.setStaffRoles).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "Remove" }));
    expect(api.setStaffRoles).toHaveBeenCalledWith("s1", "u1", [], expect.any(String));
    expect(await screen.findByRole("status")).toHaveTextContent("Ravi was removed from this store.");
  });

  it("sets a new password of at least ten characters", async () => {
    const api = fakeApi();
    const user = userEvent.setup();
    render(<Staff api={api} storeId="s1" meId="u0" />);
    await user.click(within(await rowOf("Ravi")).getByRole("button", { name: "New password" }));
    const dialog = screen.getByRole("dialog", { name: "New password for Ravi" });
    await user.type(within(dialog).getByLabelText(/New password/), "123456789");
    expect(within(dialog).getByRole("button", { name: "Set password" })).toBeDisabled();
    await user.type(within(dialog).getByLabelText(/New password/), "0");
    await user.click(within(dialog).getByRole("button", { name: "Set password" }));
    expect(api.setStaffPassword).toHaveBeenCalledWith("s1", "u1", "1234567890", expect.any(String));
    expect(await screen.findByRole("status")).toHaveTextContent("Ravi has a new password and was signed out everywhere.");
  });
});
