namespace SampleApp.Validation;

/// <summary>
/// Validates email addresses using standard RFC 5322 patterns.
/// </summary>
public static class EmailValidator
{
    private static readonly Regex EmailRegex = new(
        @"^[\w\.-]+@[\w\.-]+\.\w{2,}$",
        RegexOptions.Compiled);

    /// <summary>
    /// Validates that an email address is properly formatted.
    /// </summary>
    /// <param name="email">The email address to validate.</param>
    /// <returns>True if the email is valid, false otherwise.</returns>
    public static bool IsValid(string email)
    {
        if (string.IsNullOrWhiteSpace(email))
            return false;

        return EmailRegex.IsMatch(email);
    }

    /// <summary>
    /// Validates email and checks MX records exist.
    /// </summary>
    public static async Task<bool> IsValidWithMxCheck(string email)
    {
        if (!IsValid(email))
            return false;

        var domain = email.Split('@')[1];
        return await DnsHelper.HasMxRecord(domain);
    }
}
