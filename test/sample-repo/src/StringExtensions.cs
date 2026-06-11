using System.Text.RegularExpressions;

namespace SampleApp.Extensions;

/// <summary>
/// Extension methods for string manipulation.
/// </summary>
public static class StringExtensions
{
    // DUPLICATE: This does the same thing as EmailValidator.IsValid
    public static bool IsValidEmail(this string email)
    {
        if (string.IsNullOrWhiteSpace(email))
            return false;

        var regex = new Regex(@"^[\w\.-]+@[\w\.-]+\.\w{2,}$");
        return regex.IsMatch(email);
    }

    public static bool IsValidPhoneNumber(this string phone)
    {
        if (string.IsNullOrWhiteSpace(phone))
            return false;

        var cleaned = new string(phone.Where(char.IsDigit).ToArray());
        return cleaned.Length == 10 || cleaned.Length == 11;
    }

    public static string ToSlug(this string text)
    {
        if (string.IsNullOrWhiteSpace(text))
            return string.Empty;

        return Regex.Replace(text.ToLower(), @"[^a-z0-9]+", "-").Trim('-');
    }

    // UNUSED: This method is never called - for testing unused code detection
    private static string LegacyNormalize(string input)
    {
        return input?.Trim().ToLowerInvariant() ?? string.Empty;
    }
}
