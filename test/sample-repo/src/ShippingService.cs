namespace SampleApp.Services;

/// <summary>
/// Calculates shipping costs based on weight and destination.
/// </summary>
public class ShippingService : IShippingService
{
    private readonly IShippingRateProvider _rateProvider;

    public ShippingService(IShippingRateProvider rateProvider)
    {
        _rateProvider = rateProvider;
    }

    /// <summary>
    /// Calculate shipping cost for domestic orders.
    /// </summary>
    /// <param name="weightKg">Package weight in kilograms.</param>
    /// <param name="zone">Shipping zone (1-8).</param>
    /// <returns>Shipping cost in dollars.</returns>
    public decimal CalculateDomesticShipping(decimal weightKg, int zone)
    {
        if (weightKg <= 0)
            throw new ArgumentException("Weight must be positive", nameof(weightKg));

        if (zone < 1 || zone > 8)
            throw new ArgumentException("Zone must be between 1 and 8", nameof(zone));

        var baseRate = _rateProvider.GetBaseRate(zone);
        var weightRate = _rateProvider.GetWeightRate(weightKg);

        return baseRate + (weightKg * weightRate);
    }

    /// <summary>
    /// Calculate shipping cost for international orders.
    /// </summary>
    public decimal CalculateInternationalShipping(decimal weightKg, string countryCode)
    {
        if (weightKg <= 0)
            throw new ArgumentException("Weight must be positive", nameof(weightKg));

        var countryRate = _rateProvider.GetCountryRate(countryCode);
        var weightRate = _rateProvider.GetInternationalWeightRate(weightKg);

        return countryRate + (weightKg * weightRate);
    }

    /// <summary>
    /// Get estimated delivery date.
    /// </summary>
    public DateTime GetEstimatedDelivery(int zone, bool expedited = false)
    {
        var baseDays = zone switch
        {
            1 or 2 => 2,
            3 or 4 => 3,
            5 or 6 => 5,
            _ => 7
        };

        if (expedited)
            baseDays = Math.Max(1, baseDays / 2);

        return DateTime.UtcNow.AddDays(baseDays);
    }
}

public interface IShippingService
{
    decimal CalculateDomesticShipping(decimal weightKg, int zone);
    decimal CalculateInternationalShipping(decimal weightKg, string countryCode);
    DateTime GetEstimatedDelivery(int zone, bool expedited = false);
}

public interface IShippingRateProvider
{
    decimal GetBaseRate(int zone);
    decimal GetWeightRate(decimal weightKg);
    decimal GetCountryRate(string countryCode);
    decimal GetInternationalWeightRate(decimal weightKg);
}
