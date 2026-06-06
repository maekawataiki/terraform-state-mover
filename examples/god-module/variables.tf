variable "vpc_id" {
  type    = string
  default = "vpc-123"
}

variable "subnet_ids" {
  type    = list(string)
  default = ["subnet-1", "subnet-2"]
}

variable "security_group_id" {
  type    = string
  default = "sg-123"
}

variable "cluster_name" {
  type    = string
  default = "mega-cluster"
}

variable "instance_type" {
  type    = string
  default = "t3.medium"
}

variable "min_size" {
  type    = number
  default = 1
}

variable "max_size" {
  type    = number
  default = 10
}

variable "desired_capacity" {
  type    = number
  default = 3
}

variable "ami_id" {
  type    = string
  default = "ami-123"
}

variable "key_name" {
  type    = string
  default = "my-key"
}

variable "iam_role_arn" {
  type    = string
  default = "arn:aws:iam::111111111111:role/mega-role"
}

variable "certificate_arn" {
  type    = string
  default = "arn:aws:acm:us-east-1:111111111111:certificate/abc"
}

variable "domain_name" {
  type    = string
  default = "mega.example.com"
}

variable "hosted_zone_id" {
  type    = string
  default = "Z123"
}

variable "log_bucket" {
  type    = string
  default = "mega-logs"
}
