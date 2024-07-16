const express = require('express');
const router = express.Router();
const authTokenHandler = require('../Middlewares/checkAuthToken');
const request = require('request');
const User = require('../Models/UserSchema');
require('dotenv').config();

function createResponse(ok, message, data) {
    return {
        ok,
        message,
        data,
    };
}

router.get('/test', authTokenHandler, async (req, res) => {
    res.json(createResponse(true, 'Test API works for calorie intake report'));
});

router.post('/addcalorieintake', authTokenHandler, async (req, res) => {
    const { item, date, quantity, quantitytype } = req.body;

    if (!item || !date || !quantity || !quantitytype) {
        return res.status(400).json(createResponse(false, 'Please provide all the details'));
    }

    const parsedQuantity = parseFloat(quantity);
    if (isNaN(parsedQuantity)) {
        return res.status(400).json(createResponse(false, 'Quantity must be a valid number'));
    }

    let qtyInGrams = 0;
    switch (quantitytype) {
        case 'g':
            qtyInGrams = parsedQuantity;
            break;
        case 'kg':
            qtyInGrams = parsedQuantity * 1000;
            break;
        case 'ml':
            qtyInGrams = parsedQuantity;
            break;
        case 'l':
            qtyInGrams = parsedQuantity * 1000;
            break;
        default:
            return res.status(400).json(createResponse(false, 'Invalid quantity type'));
    }

    if (isNaN(qtyInGrams)) {
        return res.status(400).json(createResponse(false, 'Calculated quantity in grams is invalid'));
    }

    const query = item;
    request.get({
        url: `https://api.api-ninjas.com/v1/nutrition?query=${query}`,
        headers: {
            'X-Api-Key': process.env.NUTRITION_API_KEY,
        },
    }, async (error, response, body) => {
        if (error) {
            console.error('Request failed:', error);
            return res.status(500).json(createResponse(false, 'Request failed', error));
        }

        if (response.statusCode !== 200) {
            console.error('Error:', response.statusCode, body.toString('utf8'));
            return res.status(response.statusCode).json(createResponse(false, 'Error', body.toString('utf8')));
        }

        try {
            body = JSON.parse(body);
            console.log('API response body:', body);

            if (!Array.isArray(body) || body.length === 0) {
                console.error('Invalid API response:', body);
                return res.status(500).json(createResponse(false, 'Invalid API response'));
            }

            const calories = parseFloat(body[0].calories);
            const servingSizeG = parseFloat(body[0].serving_size_g);

            if (isNaN(calories) || isNaN(servingSizeG)) {
                // Notify the user about the premium content restriction
                console.error('API response contains invalid values for calories or serving size:', body);
                return res.status(500).json(createResponse(false, 'API response contains invalid values for calories or serving size. Please ensure you have access to the required data.'));
            }

            let calorieIntake = (calories / servingSizeG) * qtyInGrams;
            console.log('Calculated calorie intake:', calorieIntake);

            if (isNaN(calorieIntake)) {
                console.error('Failed to calculate calorie intake:', calorieIntake);
                return res.status(500).json(createResponse(false, 'Failed to calculate calorie intake'));
            }

            const userId = req.userId;
            const user = await User.findOne({ _id: userId });

            if (!user) {
                return res.status(404).json(createResponse(false, 'User not found'));
            }

            user.calorieIntake.push({
                item,
                date: new Date(date),
                quantity: parsedQuantity,
                quantitytype,
                calorieIntake: parseInt(calorieIntake),
            });

            await user.save();
            res.json(createResponse(true, 'Calorie intake added successfully'));
        } catch (parseError) {
            console.error('Error parsing API response:', parseError);
            return res.status(500).json(createResponse(false, 'Error parsing API response', parseError));
        }
    });
});

router.post('/getcalorieintakebydate', authTokenHandler, async (req, res) => {
    const { date } = req.body;
    const userId = req.userId;
    const user = await User.findById({ _id: userId });
    if (!date) {
        let date = new Date();
        user.calorieIntake = filterEntriesByDate(user.calorieIntake, date);

        return res.json(createResponse(true, 'Calorie intake for today', user.calorieIntake));
    }
    user.calorieIntake = filterEntriesByDate(user.calorieIntake, new Date(date));
    res.json(createResponse(true, 'Calorie intake for the date', user.calorieIntake));
});

router.post('/getcalorieintakebylimit', authTokenHandler, async (req, res) => {
    const { limit } = req.body;
    const userId = req.userId;
    const user = await User.findById({ _id: userId });
    if (!limit) {
        return res.status(400).json(createResponse(false, 'Please provide limit'));
    } else if (limit === 'all') {
        return res.json(createResponse(true, 'Calorie intake', user.calorieIntake));
    } else {
        let date = new Date();
        let currentDate = new Date(date.setDate(date.getDate() - parseInt(limit))).getTime();

        user.calorieIntake = user.calorieIntake.filter((item) => {
            return new Date(item.date).getTime() >= currentDate;
        });

        return res.json(createResponse(true, `Calorie intake for the last ${limit} days`, user.calorieIntake));
    }
});

router.delete('/deletecalorieintake', authTokenHandler, async (req, res) => {
    const { item, date } = req.body;
    if (!item || !date) {
        return res.status(400).json(createResponse(false, 'Please provide all the details'));
    }

    const userId = req.userId;
    const user = await User.findById({ _id: userId });

    user.calorieIntake = user.calorieIntake.filter((entry) => {
        return entry.item != item || entry.date != date;
    });

    await user.save();
    res.json(createResponse(true, 'Calorie intake deleted successfully'));
});

router.get('/getgoalcalorieintake', authTokenHandler, async (req, res) => {
    const userId = req.userId;
    const user = await User.findById({ _id: userId });
    let maxCalorieIntake = 0;
    let heightInCm = parseFloat(user.height[user.height.length - 1].height);
    let weightInKg = parseFloat(user.weight[user.weight.length - 1].weight);
    let age = new Date().getFullYear() - new Date(user.dob).getFullYear();
    let BMR = 0;
    let gender = user.gender;
    if (gender == 'male') {
        BMR = 88.362 + (13.397 * weightInKg) + (4.799 * heightInCm) - (5.677 * age);
    } else if (gender == 'female') {
        BMR = 447.593 + (9.247 * weightInKg) + (3.098 * heightInCm) - (4.330 * age);
    } else {
        BMR = 447.593 + (9.247 * weightInKg) + (3.098 * heightInCm) - (4.330 * age);
    }
    if (user.goal == 'weightLoss') {
        maxCalorieIntake = BMR - 500;
    } else if (user.goal == 'weightGain') {
        maxCalorieIntake = BMR + 500;
    } else {
        maxCalorieIntake = BMR;
    }

    res.json(createResponse(true, 'max calorie intake', { maxCalorieIntake }));
});

function filterEntriesByDate(entries, targetDate) {
    return entries.filter(entry => {
        const entryDate = new Date(entry.date);
        return (
            entryDate.getDate() === targetDate.getDate() &&
            entryDate.getMonth() === targetDate.getMonth() &&
            entryDate.getFullYear() === targetDate.getFullYear()
        );
    });
}

module.exports = router;
