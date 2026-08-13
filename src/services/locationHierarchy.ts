import { City, Country, State } from 'country-state-city'
import chinaAreaData from 'china-area-data'

export interface LocationOption {
  code: string
  name: string
}

type ChinaAreaMap = Record<string, Record<string, string>>

const chinaAreas = chinaAreaData as ChinaAreaMap
const countryNames = typeof Intl.DisplayNames === 'function'
  ? new Intl.DisplayNames(['zh-CN'], { type: 'region' })
  : null

const sortByName = (items: LocationOption[]) =>
  items.sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'))

export const getCountries = (): LocationOption[] => {
  const countries = Country.getAllCountries().map(country => ({
    code: country.isoCode,
    name: countryNames?.of(country.isoCode) || country.name,
  }))

  return sortByName(countries)
}

export const getProvinces = (countryCode: string): LocationOption[] => {
  if (countryCode === 'CN') {
    return Object.entries(chinaAreas['86'] || {}).map(([code, name]) => ({ code, name }))
  }

  return sortByName(State.getStatesOfCountry(countryCode).map(state => ({
    code: state.isoCode,
    name: state.name,
  })))
}

export const getCities = (countryCode: string, provinceCode: string): LocationOption[] => {
  if (!provinceCode) return []
  if (countryCode === 'CN') {
    return Object.entries(chinaAreas[provinceCode] || {}).map(([code, name]) => ({ code, name }))
  }

  return sortByName(City.getCitiesOfState(countryCode, provinceCode).map(city => ({
    code: `${city.name}|${city.latitude || ''}|${city.longitude || ''}`,
    name: city.name,
  })))
}

export const getDistricts = (
  countryCode: string,
  _provinceCode: string,
  cityCode: string,
): LocationOption[] => {
  if (!cityCode || countryCode !== 'CN') return []
  return Object.entries(chinaAreas[cityCode] || {}).map(([code, name]) => ({ code, name }))
}
