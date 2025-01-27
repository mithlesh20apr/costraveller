import Amadeus from "amadeus"
import { logger } from "../../config/logger.config.js"
import { formatDuration } from "../utils/helper.utils.js";
import { redisClient } from "../../config/redis.config.js";
import dotenv from 'dotenv';
import axios from 'axios';

dotenv.config();

// amadeus config
const amadeus = new Amadeus({
    clientId: process.env.AMADEUS_API_KEY,
    clientSecret: process.env.AMADEUS_SECRET_KEY,
    logger
});

const convertCurrency = async (amount, fromCurrency, toCurrency) => {
    try {
        const response = await axios.get(`https://api.exchangerate-api.com/v4/latest/${fromCurrency}`);
        const rate = response.data.rates[toCurrency];
        return (amount * rate).toFixed(2);
    } catch (error) {
        logger.error('Error converting currency:', error);
        throw error;
    }
}

//flight offer
const flightOffers = async (origin, destination, departureDate, adults) => {
    //implementing catching
    const flights = await redisClient.hGet('flight', `${origin}-${destination}-${departureDate}-}-${adults}`);
   
    if (flights) {
        return JSON.parse(flights)
    } else {
        try {
            const newFlights = await amadeus.shopping.flightOffersSearch.get({
                originLocationCode: origin,
                destinationLocationCode: destination,
                departureDate,
                adults // this is hardcoded, you can always make it dynamic, default = 10
            })
            if (newFlights && newFlights.data) {
                await redisClient.hSet('flight', `${origin}-${destination}-${departureDate}-}-${adults}`, JSON.stringify(newFlights))
                return newFlights
            } else {
                logger.error('No flight data returned from Amadeus API');
                return null;
            }
        } catch (error) {
            logger.error('Error fetching flight offers:', error);
            throw error;
        }
    }
}

//search flight offers
export const flightSearcService = async (origin, destination, departureDate, adults) => {
    const flights = await flightOffers(origin, destination, departureDate, adults);
    return Promise.all(flights.data.map(async (flight) => {
        const priceInRupees = await convertCurrency(flight.price.grandTotal, flight.price.currency, 'INR');
        return {
            id: flight.id,
            airline: flight.validatingAirlineCodes[0],
            segments: flight.itineraries[0].segments.map(segment => ({
                flightNumber: segment.number,
                departure: segment.departure,
                arrival: segment.arrival,
                duration: formatDuration(segment.duration)
            })),
            numberOfBookableSeats: flight.numberOfBookableSeats,
            price: parseFloat(priceInRupees),
            currency: 'INR'
        }
    }));
}

export const flightComfirmationService = async (origin, destination, departureDate, adults, id) => {
    const flights = await flightOffers(origin, destination, departureDate, adults)

    const flightPriceComfirmation = await redisClient.hGet('price', `${origin}-${destination}-${departureDate}-${adults}`)
    if (flightPriceComfirmation) {
        return JSON.parse(flightPriceComfirmation)
    } else {
        const newFlightPriceComfirmation = await amadeus.shopping.flightOffers.pricing.post(
            JSON.stringify({
                "data": {
                    "type": "flight-offers-pricing",
                    "flightOffers": [
                        flights.data[id]
                    ]
                }
            })
        )
        await redisClient.hSet('price', `${origin}-${destination}-${departureDate}-${adults}`, JSON.stringify(newFlightPriceComfirmation.data))
        return newFlightPriceComfirmation.data
    }
}

export const flightBookingService = async (origin, destination, departureDate, adults, id, contactDetails) => {
    const pricing = await flightComfirmationService(origin, destination, departureDate, adults, id)

    // implementing redis for caching
    const booking = await redisClient.hGet('booking', `${origin}-${destination}-${departureDate}-${adults}`)
    if (booking) {
        return JSON.parse(booking)
    } else {
        const flightBooking = await amadeus.booking.flightOrders.post(
            JSON.stringify({
                'data': {
                    'type': 'flight-order',
                    'flightOffers': [pricing.flightOffers[0]],
                    'travelers': [
                        ...contactDetails
                    ]
                }
            })

        );

        await redisClient.hSet('booking', `${origin}-${destination}-${departureDate}-${adults}`, JSON.stringify(flightBooking.data))
        return flightBooking.data
    }
}


