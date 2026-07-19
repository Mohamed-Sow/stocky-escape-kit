export function getSupportEmail() {
  const email = process.env.SUPPORT_EMAIL?.trim() ?? "";

  return /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(email) ? email : null;
}
