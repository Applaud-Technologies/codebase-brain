using System.Text.RegularExpressions;

namespace SampleApp.Helpers;

/// <summary>
/// Helper methods for order processing.
/// </summary>
public static class OrderHelpers
{
    // NEAR-DUPLICATE: Very similar to ShippingService.CalculateDomesticShipping
    // but slightly different implementation
    public static decimal ComputeShippingCost(decimal weight, int shippingZone)
    {
        if (weight <= 0)
            return 0;

        var baseRate = shippingZone * 2.50m;
        var perKgRate = weight > 10 ? 1.25m : 1.75m;

        return baseRate + (weight * perKgRate);
    }

    // DUPLICATE: Same as StringExtensions.ToSlug
    public static string GenerateSlug(string title)
    {
        if (string.IsNullOrWhiteSpace(title))
            return string.Empty;

        return Regex.Replace(title.ToLower(), @"[^a-z0-9]+", "-").Trim('-');
    }

    public static string GenerateOrderNumber()
    {
        var timestamp = DateTime.UtcNow.ToString("yyyyMMddHHmmss");
        var random = new Random().Next(1000, 9999);
        return $"ORD-{timestamp}-{random}";
    }

    public static decimal CalculateTax(decimal subtotal, string stateCode)
    {
        var taxRate = stateCode switch
        {
            "CA" => 0.0725m,
            "TX" => 0.0625m,
            "NY" => 0.08m,
            "FL" => 0.06m,
            _ => 0.05m
        };

        return Math.Round(subtotal * taxRate, 2);
    }

    public static int CalculateLoyaltyPoints(decimal orderTotal)
    {
        if (orderTotal <= 0)
            return 0;

        var multiplier = orderTotal > 100 ? 2 : 1;
        return (int)(orderTotal * multiplier);
    }
}
