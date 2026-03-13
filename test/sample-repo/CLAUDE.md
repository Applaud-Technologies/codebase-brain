# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Sample C# utility library with validation, string extensions, and e-commerce helpers. No project file or build system is currently configured.

## Architecture

- **Namespaces**: All code under `SampleApp.*` (`Validation`, `Extensions`, `Services`, `Helpers`)
- **Dependency Injection**: `ShippingService` uses constructor injection with `IShippingRateProvider`
- **Static utilities**: `EmailValidator`, `StringExtensions`, `OrderHelpers` are static classes

## Known Issues

The codebase contains intentional duplicates (marked with `DUPLICATE` comments):
- `StringExtensions.IsValidEmail` duplicates `EmailValidator.IsValid`
- `OrderHelpers.GenerateSlug` duplicates `StringExtensions.ToSlug`
- `OrderHelpers.ComputeShippingCost` is a near-duplicate of `ShippingService.CalculateDomesticShipping`
