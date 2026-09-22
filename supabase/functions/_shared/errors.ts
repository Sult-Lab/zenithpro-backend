export function mapError(message: string): string {
  // Postgres constraint violations
  if (message.includes("duplicate key") ||
      message.includes("unique constraint")) {
    if (message.includes("products_business_id_name_key"))
      return "A product with this name already exists.";
    if (message.includes("user_profiles_email"))
      return "An account with this email already exists.";
    return "This record already exists.";
  }

  // Stock errors from process_sale()
  if (message.includes("Insufficient stock"))
    return message; // this one is already clean — keep it

  // FK violations
  if (message.includes("foreign key constraint"))
    return "Operation failed — a related record does not exist.";

  // Auth errors
  if (message.includes("JWT"))
    return "Your session has expired. Please sign in again.";

  if (message.includes("not found") ||
      message.includes("No rows"))
    return "The requested record was not found.";

  // RLS / permission
  if (message.includes("RLS") ||
      message.includes("permission denied") ||
      message.includes("policy"))
    return "You do not have permission to perform this action.";

  // Network / timeout
  if (message.includes("timeout") ||
      message.includes("connection"))
    return "Connection error. Please try again.";

  // Catch-all — never expose raw Postgres/Supabase message
  return "Something went wrong. Please try again.";
}

export function getStatus(message: string): number {
  if (message.includes("duplicate key") ||
      message.includes("unique constraint"))   return 409;
  if (message.includes("Insufficient stock")) return 422;
  if (message.includes("not found") ||
      message.includes("No rows"))             return 404;
  if (message.includes("permission denied") ||
      message.includes("UNAUTHORIZED"))        return 403;
  if (message.includes("JWT"))                 return 401;
  return 500;
}