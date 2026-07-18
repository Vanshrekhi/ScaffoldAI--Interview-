import jwt from "jsonwebtoken"


const isAuth = async (req, res, next) => {
    try {
        const authHeader = req.headers.authorization

        if (!authHeader || !authHeader.startsWith("Bearer ")) {
            return res.status(400).json({ message: "user does not have a token" })
        }

        const token = authHeader.split(" ")[1]
        const verifyToken = jwt.verify(token, process.env.JWT_SECRET)

        if (!verifyToken) {
            return res.status(400).json({ message: "user does not have a valid token" })
        }

        req.userId = verifyToken.userId
        next()
    } catch (error) {
        return res.status(500).json({ message: `isAuth error ${error}` })
    }
}

export default isAuth
